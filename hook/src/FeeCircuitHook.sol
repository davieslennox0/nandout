// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {SSTORE2} from "latch/vendor/tapeout/lib/SSTORE2.sol";
import {ICPU} from "latch/vendor/tapeout/interfaces/ICPU.sol";
import {ICircuitRegistryView, ILatchEvaluator} from "latch/interfaces/ILatch.sol";

/// @title FeeCircuitHook: LP fee policy as an immutable, publicly readable TapeOut circuit.
/// @notice Solidity measures the pool and reduces it to 5 yes/no facts. Two taped-out NAND circuits (VOL_GUARD,
///         DEPTH_GUARD) map those facts to a 2-bit tier; the tier picks one of four LP fees fixed at deploy.
///
///         The circuits are evaluated exhaustively ONCE, here in the constructor, by Nandout's LatchEvaluator (stateless,
///         ownerless, no proxy) on a frozen copy of each netlist. All 32 answers are stored as an immutable 64-bit table,
///         and each swap looks its tier up (+~13k gas instead of +43-98k for live evaluation; docs/HOOK-RECON.md).
///         The table is the circuits' complete output: anyone can recompute it from the stored netlists.
///
///         Nothing is admin-controlled: no owner, no setters, no upgrade path. TapeOut's factory is upgradeable
///         (isSealed() == false), so the hook never calls TapeOut after construction; a later TapeOut upgrade cannot
///         change the fee (see test_maliciousTapeOutUpgradeCannotChangeFee).
///
///         Pools must be initialised with fee = LPFeeLibrary.DYNAMIC_FEE_FLAG for the override to apply.
contract FeeCircuitHook is IHooks {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    // ---- fact bits (hook/circuits/compile.ts FEE_BITS) -------------------------------------------------------------
    uint8 internal constant VOL_HIGH = 1 << 0;
    uint8 internal constant VOL_ELEVATED = 1 << 1;
    uint8 internal constant DEPTH_THIN = 1 << 2;
    uint8 internal constant DEPTH_CRITICAL = 1 << 3;
    uint8 internal constant DEPTH_DRAIN = 1 << 4;
    uint256 internal constant N_FACT_WORDS = 32;

    struct Guard {
        ICPU cpu; // TapeOut processor the circuit was taped out on (Nandout's processor)
        uint256 circuitId;
        bytes32 netlistHash; // keccak256 of the netlist the deployer compiled and verified
    }

    /// @notice Fact thresholds. Volatility is an EWMA of per-epoch tick displacement, in hundredths of a tick.
    struct Thresholds {
        uint32 volHigh;
        uint32 volElevated;
        uint128 depthThin;
        uint128 depthCritical;
    }

    /// @dev Slot A: only written on the first swap of an epoch. Slot B: only written when liquidity sets a new low.
    struct Window {
        uint32 epoch;
        int24 anchorTick; // tick before the first swap of `epoch`
        uint32 vol; // EWMA of |anchor_k - anchor_{k-1}| * 100
        uint128 prevMin; // lowest in-range liquidity seen during the last epoch that had swaps
    }

    IPoolManager public immutable poolManager;
    ILatchEvaluator public immutable evaluator;
    address public immutable volNetlist; // SSTORE2 pointers: the frozen circuits, readable forever
    address public immutable depthNetlist;
    uint64 public immutable table; // tier for fact word f = (table >> 2f) & 3
    uint24 public immutable fee0;
    uint24 public immutable fee1;
    uint24 public immutable fee2;
    uint24 public immutable fee3;
    uint32 public immutable volHigh;
    uint32 public immutable volElevated;
    uint128 public immutable depthThin;
    uint128 public immutable depthCritical;
    uint32 public immutable epochBlocks;

    mapping(PoolId => Window) public window;
    mapping(PoolId => uint128) public curMin; // lowest in-range liquidity seen so far in the current epoch

    event Registered(address volNetlist, address depthNetlist, uint64 table, uint24[4] fees);

    error NotPoolManager();
    error HookNotImplemented();
    error NotTapeOutCircuit(address cpu);
    error BadShape(uint32 nIn, uint32 nOut, uint32 nState);
    error NetlistMismatch(bytes32 expected, bytes32 actual);
    error NetlistShape();
    error FeeTooLarge(uint24 fee);
    error BadConfig();

    constructor(
        IPoolManager poolManager_,
        ILatchEvaluator evaluator_,
        ICircuitRegistryView tapeout,
        Guard memory volGuard,
        Guard memory depthGuard,
        uint24[4] memory fees,
        Thresholds memory t,
        uint32 epochBlocks_
    ) {
        Hooks.validateHookPermissions(IHooks(address(this)), getHookPermissions());
        for (uint256 i = 0; i < 4; i++) if (fees[i] > LPFeeLibrary.MAX_LP_FEE) revert FeeTooLarge(fees[i]);
        if (epochBlocks_ == 0 || t.volHigh < t.volElevated || t.depthCritical > t.depthThin) revert BadConfig();

        poolManager = poolManager_;
        evaluator = evaluator_;
        address vp = _snapshot(evaluator_, tapeout, volGuard);
        address dp = _snapshot(evaluator_, tapeout, depthGuard);
        volNetlist = vp;
        depthNetlist = dp;

        // Exhaustive evaluation: the circuits' complete output, computed once by the sealed evaluator.
        uint64 tbl;
        for (uint256 f = 0; f < N_FACT_WORDS; f++) {
            (bool v,) = evaluator_.evaluate(vp, "", uint16(f));
            (bool d,) = evaluator_.evaluate(dp, "", uint16(f));
            tbl |= uint64((v ? 2 : 0) | (d ? 1 : 0)) << uint64(2 * f);
        }
        table = tbl;
        (fee0, fee1, fee2, fee3) = (fees[0], fees[1], fees[2], fees[3]);
        (volHigh, volElevated, depthThin, depthCritical) = (t.volHigh, t.volElevated, t.depthThin, t.depthCritical);
        epochBlocks = epochBlocks_;
        emit Registered(vp, dp, tbl, fees);
    }

    /// @dev Same checks as LatchGate.registerFilter: registered TapeOut CPU, 16-in/1-out, combinational, the exact
    ///      netlist the deployer verified, and a self-contained shape (any REF reverts in analyze).
    function _snapshot(ILatchEvaluator ev, ICircuitRegistryView tapeout, Guard memory g) internal returns (address) {
        if (!tapeout.isCPU(address(g.cpu))) revert NotTapeOutCircuit(address(g.cpu));
        (uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount) = g.cpu.circuitInfo(g.circuitId);
        if (nIn != 16 || nOut != 1 || nState != 0) revert BadShape(nIn, nOut, nState);
        bytes memory nl = g.cpu.netlist(g.circuitId);
        bytes32 h = keccak256(nl);
        if (h != g.netlistHash) revert NetlistMismatch(g.netlistHash, h);
        (uint256 nNand, uint256 nLatch, uint32 aState, uint32 aGates) = ev.analyze(nl);
        if (aState != 0 || nLatch != 0 || aGates != gateCount || nNand != gateCount) revert NetlistShape();
        return SSTORE2.write(nl);
    }

    function getHookPermissions() public pure virtual returns (Hooks.Permissions memory p) {
        p.beforeSwap = true;
    }

    // ---- views --------------------------------------------------------------------------------------------------

    function tierOf(uint8 facts) public view returns (uint8) {
        return uint8((table >> (2 * uint256(facts & 31))) & 3);
    }

    function feeOfTier(uint8 tier) public view returns (uint24) {
        return tier == 0 ? fee0 : tier == 1 ? fee1 : tier == 2 ? fee2 : fee3;
    }

    /// @notice The facts the next swap would see (read-only preview; does not roll the window).
    function currentFacts(PoolKey calldata key) external view returns (uint8 facts) {
        PoolId id = key.toId();
        (, int24 tick,,) = poolManager.getSlot0(id);
        uint128 liq = poolManager.getLiquidity(id);
        Window memory w = window[id];
        uint32 e = uint32(block.number / epochBlocks);
        uint128 cm = curMin[id];
        if (e != w.epoch) (w, cm) = _rolled(w, cm, e, tick, liq);
        return _pack(w, cm, liq);
    }

    // ---- hook ---------------------------------------------------------------------------------------------------

    function beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        external
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        uint8 facts = _facts(key);
        _onFacts(key, params, facts);
        uint24 fee = feeOfTier(_tier(facts));
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, fee | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    /// @dev Measures the pool, updates the window, packs the 5 fact bits. Solidity does all arithmetic; the circuit
    ///      only ever sees these bits.
    function _facts(PoolKey calldata key) internal virtual returns (uint8) {
        PoolId id = key.toId();
        (, int24 tick,,) = poolManager.getSlot0(id);
        uint128 liq = poolManager.getLiquidity(id);
        uint32 e = uint32(block.number / epochBlocks);
        Window memory w = window[id];
        uint128 cm = curMin[id];
        if (e != w.epoch) {
            (w, cm) = _rolled(w, cm, e, tick, liq);
            window[id] = w;
            curMin[id] = cm;
        } else if (liq < cm) {
            cm = liq;
            curMin[id] = cm;
        }
        return _pack(w, cm, liq);
    }

    /// @dev Extension point for consumers of the same facts (FeeRouteHook). No-op here.
    function _onFacts(PoolKey calldata key, SwapParams calldata params, uint8 facts) internal virtual {}

    /// @dev Tier lookup. Virtual only so the gas benchmark can compare against live evaluation.
    function _tier(uint8 facts) internal view virtual returns (uint8) {
        return tierOf(facts);
    }

    /// @dev Epoch rollover. Volatility samples the tick once per epoch, before the epoch's first swap executes, so a
    ///      displacement must survive an epoch boundary to register. Depth keeps the lowest liquidity observed during
    ///      the last epoch with swaps, so borrowed (JIT) liquidity only counts if it was present at every observation
    ///      of a whole epoch.
    function _rolled(Window memory w, uint128 cm, uint32 e, int24 tick, uint128 liq)
        private
        pure
        returns (Window memory, uint128)
    {
        if (w.epoch == 0 && w.anchorTick == 0 && w.vol == 0 && w.prevMin == 0) {
            // First swap ever: no history. Floor depth at what is here now; volatility starts calm.
            return (Window(e, tick, 0, liq), liq);
        }
        uint256 move = tick > w.anchorTick ? uint256(int256(tick) - w.anchorTick) : uint256(int256(w.anchorTick) - tick);
        uint256 vol = (uint256(w.vol) * 3 + move * 100) / 4;
        uint256 skipped = e > w.epoch + 1 ? e - w.epoch - 1 : 0; // idle epochs decay the estimate
        for (uint256 i = 0; i < skipped && i < 16 && vol > 0; i++) vol = (vol * 3) / 4;
        if (vol > type(uint32).max) vol = type(uint32).max;
        return (Window(e, tick, uint32(vol), cm), liq);
    }

    function _pack(Window memory w, uint128 cm, uint128 liq) private view returns (uint8 f) {
        uint128 depth = liq;
        if (w.prevMin < depth) depth = w.prevMin;
        if (cm < depth) depth = cm;
        if (w.vol >= volHigh) f |= VOL_HIGH;
        if (w.vol >= volElevated) f |= VOL_ELEVATED;
        if (depth < depthThin) f |= DEPTH_THIN;
        if (depth < depthCritical) f |= DEPTH_CRITICAL;
        if (liq < w.prevMin / 2) f |= DEPTH_DRAIN;
    }

    // ---- unused callbacks (permission bits are zero, so the PoolManager never calls them) ----------------------

    function beforeInitialize(address, PoolKey calldata, uint160) external pure returns (bytes4) { revert HookNotImplemented(); }
    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) { revert HookNotImplemented(); }
    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata) external pure returns (bytes4) { revert HookNotImplemented(); }
    function afterAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata) external pure returns (bytes4, BalanceDelta) { revert HookNotImplemented(); }
    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata) external pure returns (bytes4) { revert HookNotImplemented(); }
    function afterRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata) external pure returns (bytes4, BalanceDelta) { revert HookNotImplemented(); }
    function afterSwap(address, PoolKey calldata, SwapParams calldata, BalanceDelta, bytes calldata) external virtual returns (bytes4, int128) { revert HookNotImplemented(); }
    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) { revert HookNotImplemented(); }
    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) { revert HookNotImplemented(); }
}
