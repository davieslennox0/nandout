// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {ICPU} from "latch/vendor/tapeout/interfaces/ICPU.sol";
import {ICircuitRegistryView, ILatchEvaluator} from "latch/interfaces/ILatch.sol";
import {FeeCircuitHook} from "../src/FeeCircuitHook.sol";

interface ITransistors {
    function mint(uint256 id, uint256 amount) external payable;
    function mintPrice() external view returns (uint256);
    function protocolFee() external view returns (uint256);
}

interface ICircuitsTapeout {
    function tapeout(bytes calldata nl, uint32 nIn, uint32 nOut) external payable returns (uint256);
    function TAPEOUT_FEE() external view returns (uint256);
    function transistors() external view returns (address);
}

/// Test-only: facts forced from storage so every one of the 32 fact words can be driven through real swaps.
contract ForcedFactsHook is FeeCircuitHook {
    uint8 public forced;

    constructor(
        IPoolManager pm,
        ILatchEvaluator ev,
        ICircuitRegistryView reg,
        Guard memory v,
        Guard memory d,
        uint24[4] memory fees,
        Thresholds memory t,
        uint32 epoch
    ) FeeCircuitHook(pm, ev, reg, v, d, fees, t, epoch) {}

    function force(uint8 f) external { forced = f; }

    function _facts(PoolKey calldata) internal view override returns (uint8) { return forced; }
}

/// A hostile TapeOut upgrade: every eval "passes", netlists are garbage.
contract EvilCPU {
    function eval(uint256, bytes calldata) external pure returns (bytes memory) { return hex"01"; }
    function netlist(uint256) external pure returns (bytes memory) { return hex"deadbeef"; }
    function circuitInfo(uint256) external pure returns (uint32, uint32, uint32, uint32) { return (16, 1, 0, 1); }
}

/// @notice FeeCircuitHook against the real X Layer contracts on a local fork (nothing is broadcast):
///         PoolManager 0x360E…FB32, Nandout's TapeOut processor 0x8A60…a58E, Nandout's LatchEvaluator 0x8cA3…2D03.
///         Skipped unless XLAYER_RPC_URL is set.
contract FeeCircuitHookForkTest is Test {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    IPoolManager internal constant PM = IPoolManager(0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32);
    ILatchEvaluator internal constant EVALUATOR = ILatchEvaluator(0x8cA3ecB418962801e64FF1e847a444fAB6352D03);
    ICircuitRegistryView internal constant TAPEOUT = ICircuitRegistryView(0x1f09DAeFA827f02CBb40967cc91b259763760761);
    address internal constant PROCESSOR = 0x8A60B4A4BCf4066F5E5F9A406fE09c5e4f52a58E;
    bytes32 internal constant SWAP_EVENT = keccak256("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");
    uint160 internal constant ALL_HOOK_FLAGS = (1 << 14) - 1;
    uint160 internal constant BEFORE_SWAP_FLAG = 1 << 7;

    uint32 internal constant EPOCH = 60; // blocks (~60 s at X Layer's 1.0 s block time)
    uint24[4] internal FEES = [uint24(500), 3000, 6000, 10000]; // 0.05% / 0.30% / 0.60% / 1.00%
    FeeCircuitHook.Thresholds internal T = FeeCircuitHook.Thresholds({
        volHigh: 20_000, // EWMA units: one epoch displacement of m ticks adds 25*m -> 800 ticks (~8.3%) in one epoch
        volElevated: 5_000, // 200 ticks (~2%) in one epoch
        depthThin: 1e22,
        depthCritical: 1e21
    });

    FeeCircuitHook.Guard internal volGuard;
    FeeCircuitHook.Guard internal depthGuard;
    uint8[32] internal fixtureTiers;
    uint64 internal fixtureTable;

    MockERC20 internal t0;
    MockERC20 internal t1;
    PoolSwapTest internal swapRouter;
    PoolModifyLiquidityTest internal liqRouter;
    address internal taper = makeAddr("taper");

    function setUp() public {
        string memory rpc = vm.envOr("XLAYER_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);

        // Tape out both guards on Nandout's existing processor (on the fork only).
        string memory json = vm.readFile("test/fixtures/fee-circuits.json");
        volGuard = _tapeout(json, 0);
        depthGuard = _tapeout(json, 1);
        for (uint256 f = 0; f < 32; f++) fixtureTiers[f] = uint8(vm.parseJsonUint(json, string.concat(".tiers[", vm.toString(f), "]")));
        fixtureTable = uint64(vm.parseJsonUint(json, ".table"));

        MockERC20 a = new MockERC20("A", "A", 18);
        MockERC20 b = new MockERC20("B", "B", 18);
        (t0, t1) = address(a) < address(b) ? (a, b) : (b, a);
        swapRouter = new PoolSwapTest(PM);
        liqRouter = new PoolModifyLiquidityTest(PM);
        t0.mint(address(this), 1e40);
        t1.mint(address(this), 1e40);
        t0.approve(address(swapRouter), type(uint256).max);
        t1.approve(address(swapRouter), type(uint256).max);
        t0.approve(address(liqRouter), type(uint256).max);
        t1.approve(address(liqRouter), type(uint256).max);
    }

    // ---- 1. the table is the circuits' complete output ------------------------------------------------------------

    function test_tableEqualsLiveTapeOutEvalForEveryFactWord() public {
        FeeCircuitHook hook = _deployHook();
        assertEq(hook.table(), fixtureTable, "table == DSL reference (hook/circuits/compile.ts)");
        for (uint8 f = 0; f < 32; f++) {
            uint8 live = _liveTier(f);
            assertEq(hook.tierOf(f), live, "table == TapeOut live eval");
            assertEq(live, fixtureTiers[f], "TapeOut live eval == DSL");
            (bool v,) = EVALUATOR.evaluate(hook.volNetlist(), "", f);
            (bool d,) = EVALUATOR.evaluate(hook.depthNetlist(), "", f);
            assertEq((v ? 2 : 0) | (d ? 1 : 0), live, "frozen netlist on LatchEvaluator == live eval");
        }
        // Anyone can recompute the table from the stored netlists: they are the taped-out bytes.
        assertEq(keccak256(_sstore2Read(hook.volNetlist())), volGuard.netlistHash);
        assertEq(keccak256(_sstore2Read(hook.depthNetlist())), depthGuard.netlistHash);
    }

    function test_poolChargesLiveEvalFeeForEveryFactWord() public {
        ForcedFactsHook hook = ForcedFactsHook(_deploy(type(ForcedFactsHook).creationCode));
        PoolKey memory key = _pool(address(hook), 1e23);
        for (uint8 f = 0; f < 32; f++) {
            hook.force(f);
            uint24 charged = _swapFee(key, f % 2 == 0, 1e18);
            assertEq(charged, FEES[_liveTier(f)], "applied LP fee == fee of the live-evaluated tier");
        }
    }

    // ---- 2. malicious TapeOut upgrade -------------------------------------------------------------------------------

    function test_maliciousTapeOutUpgradeCannotChangeFee() public {
        ForcedFactsHook hook = ForcedFactsHook(_deploy(type(ForcedFactsHook).creationCode));
        PoolKey memory key = _pool(address(hook), 1e23);
        uint24[32] memory before;
        for (uint8 f = 0; f < 32; f++) { hook.force(f); before[f] = _swapFee(key, f % 2 == 0, 1e18); }
        uint64 tableBefore = hook.table();

        // Replace the processor's code: every live eval now passes (tier 3) and netlists are garbage.
        vm.etch(PROCESSOR, type(EvilCPU).runtimeCode);
        assertEq(uint8(ICPU(PROCESSOR).eval(volGuard.circuitId, abi.encodePacked(uint8(0), uint8(0)))[0]), 1, "live path is compromised");

        for (uint8 f = 0; f < 32; f++) {
            hook.force(f);
            assertEq(_swapFee(key, f % 2 == 0, 1e18), before[f], "fee unchanged after the upgrade");
        }
        assertEq(hook.table(), tableBefore);
    }

    function test_constructorRejectsWrongNetlistAndNonTapeOutCpu() public {
        FeeCircuitHook.Guard memory wrong = volGuard;
        wrong.netlistHash = keccak256("not the verified netlist");
        assertEq(_deployRevert(wrong, depthGuard), FeeCircuitHook.NetlistMismatch.selector);
        FeeCircuitHook.Guard memory notCpu = volGuard;
        notCpu.cpu = ICPU(address(0xBEEF));
        assertEq(_deployRevert(notCpu, depthGuard), FeeCircuitHook.NotTapeOutCircuit.selector);
    }

    // ---- 3. depth gaming (JIT liquidity) --------------------------------------------------------------------------

    /// An LP adds liquidity in the same block as its own swap to flip DEPTH_THIN off and take the lower tier.
    function test_depthWindowBlocksJitLiquidity() public {
        FeeCircuitHook hook = _deployHook();
        PoolKey memory key = _pool(address(hook), 5e21); // thin: 5e21 < depthThin 1e22
        _swapFee(key, true, 1e18); // first observation
        vm.roll(vm.getBlockNumber() + EPOCH);
        assertEq(_swapFee(key, false, 1e18), FEES[1], "thin pool pays the thin tier");

        // JIT: +1e24 liquidity (200x) right before a swap, same block.
        uint256 jitBlock = vm.getBlockNumber();
        liqRouter.modifyLiquidity(key, ModifyLiquidityParams(-6000, 6000, 1e24, bytes32("jit")), "");
        assertGt(PM.getLiquidity(_id(key)), T.depthThin, "a naive current-liquidity check would say deep");
        assertEq(_swapFee(key, true, 1e18), FEES[1], "windowed depth still thin: JIT gets no discount");

        // Holding the liquidity through the rest of this epoch is not enough either: the epoch had a thin observation.
        vm.roll((vm.getBlockNumber() / EPOCH + 1) * EPOCH);
        assertEq(_swapFee(key, false, 1e18), FEES[1], "next epoch: previous epoch's floor was thin");

        // Only after a whole epoch in which every observation saw the extra liquidity does the tier drop.
        vm.roll(vm.getBlockNumber() + EPOCH);
        assertEq(_swapFee(key, true, 1e18), FEES[0], "deep after a full epoch of real depth");
        emit log_named_uint("blocks the JIT liquidity had to stay in the pool (1 block = ~1 s)", vm.getBlockNumber() - jitBlock);
    }

    // ---- 4. volatility manipulation -------------------------------------------------------------------------------

    /// A trader displaces the price across an epoch boundary to push VOL_HIGH and raise everyone's fee.
    function test_volatilityManipulationCost() public {
        FeeCircuitHook hook = _deployHook();
        uint128 L = 1e23;
        PoolKey memory key = _pool(address(hook), L);
        _swapFee(key, true, 1e15);
        vm.roll(vm.getBlockNumber() + EPOCH);
        assertEq(_swapFee(key, false, 1e15), FEES[0], "calm + deep = bottom tier");

        // Same-epoch round trip: moves 800 ticks and back inside one epoch. Leaves no trace in the windowed measure.
        (uint256 in1, uint256 out1) = _swapToTick(key, 800);
        (uint256 in2, uint256 out2) = _swapToTick(key, 0);
        vm.roll((vm.getBlockNumber() / EPOCH + 1) * EPOCH);
        assertEq(_swapFee(key, true, 1e15), FEES[0], "intra-epoch round trip does not register");
        emit log_named_uint("round trip 800 ticks: token1 in", in1);
        emit log_named_uint("round trip 800 ticks: token0 out", out1);
        emit log_named_uint("round trip back: token0 in", in2);
        emit log_named_uint("round trip back: token1 out", out2);

        // Displacement held across the boundary: the next epoch's first swap samples the displaced tick.
        vm.roll((vm.getBlockNumber() / EPOCH + 1) * EPOCH - 1); // last block of this epoch
        (uint256 inA, uint256 outA) = _swapToTick(key, 800);
        vm.roll(vm.getBlockNumber() + 1); // first block of the next epoch
        (uint256 inB, uint256 outB) = _swapToTick(key, 0); // the attacker unwinds; this swap is sampled at +800
        assertEq(hook.currentFacts(key) & 1, 1, "VOL_HIGH after one held 800-tick displacement");
        uint24 raised = _swapFee(key, true, 1e15);
        assertEq(raised, FEES[2], "everyone now pays the volatile tier");
        // token1 paid in on the way up minus token1 received back; token0 received minus token0 paid back.
        emit log_named_uint("attack leg 1: token1 in (at 0.05%)", inA);
        emit log_named_uint("attack leg 1: token0 out", outA);
        emit log_named_uint("attack leg 2: token0 in (at the raised tier)", inB);
        emit log_named_uint("attack leg 2: token1 out", outB);
        emit log_named_int("attacker net token1 (self-unwind; negative = cost)", int256(outB) - int256(inA));
        emit log_named_int("attacker net token0 (self-unwind)", int256(outA) - int256(inB));

        // How long the raised tier lasts with no further manipulation: EWMA decays by 3/4 per epoch.
        uint256 epochsRaised = 1;
        for (uint256 i = 0; i < 10; i++) {
            vm.roll(vm.getBlockNumber() + EPOCH);
            if (_swapFee(key, i % 2 == 0, 1e15) == FEES[0]) break;
            epochsRaised++;
        }
        emit log_named_uint("epochs (~60 s each) the raised tier lasted", epochsRaised);
    }

    // ---- helpers ----------------------------------------------------------------------------------------------------

    function _tapeout(string memory json, uint256 i) internal returns (FeeCircuitHook.Guard memory g) {
        string memory p = string.concat(".circuits[", vm.toString(i), "]");
        bytes memory nl = vm.parseJsonBytes(json, string.concat(p, ".netlist"));
        uint256 nand = vm.parseJsonUint(json, string.concat(p, ".nandCount"));
        ITransistors tr = ITransistors(ICircuitsTapeout(PROCESSOR).transistors());
        vm.deal(taper, 1 ether);
        vm.startPrank(taper);
        tr.mint{value: tr.mintPrice() * nand + tr.protocolFee()}(0, nand);
        uint256 id = ICircuitsTapeout(PROCESSOR).tapeout{value: ICircuitsTapeout(PROCESSOR).TAPEOUT_FEE()}(nl, 16, 1);
        vm.stopPrank();
        g = FeeCircuitHook.Guard(ICPU(PROCESSOR), id, vm.parseJsonBytes32(json, string.concat(p, ".netlistHash")));
        assertEq(keccak256(ICPU(PROCESSOR).netlist(id)), g.netlistHash, "taped-out bytes == compiled bytes");
    }

    function _liveTier(uint8 f) internal view returns (uint8) {
        bytes memory in_ = abi.encodePacked(f, uint8(0));
        uint8 v = uint8(ICPU(PROCESSOR).eval(volGuard.circuitId, in_)[0]) & 1;
        uint8 d = uint8(ICPU(PROCESSOR).eval(depthGuard.circuitId, in_)[0]) & 1;
        return (v << 1) | d;
    }

    function _deployHook() internal returns (FeeCircuitHook) {
        return FeeCircuitHook(_deploy(type(FeeCircuitHook).creationCode));
    }

    /// Mines a CREATE2 salt so the low 14 address bits are exactly BEFORE_SWAP_FLAG, then deploys.
    function _deploy(bytes memory creationCode) internal returns (address addr) {
        bytes memory init = abi.encodePacked(creationCode, abi.encode(PM, EVALUATOR, TAPEOUT, volGuard, depthGuard, FEES, T, EPOCH));
        bytes32 h = keccak256(init);
        uint256 salt;
        for (;; salt++) {
            addr = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), bytes32(salt), h)))));
            if (uint160(addr) & ALL_HOOK_FLAGS == BEFORE_SWAP_FLAG) break;
        }
        address got;
        assembly { got := create2(0, add(init, 0x20), mload(init), salt) }
        require(got == addr && got.code.length > 0, "deploy");
    }

    function _deployRevert(FeeCircuitHook.Guard memory v, FeeCircuitHook.Guard memory d) internal returns (bytes4) {
        bytes32 h = keccak256(abi.encodePacked(type(FeeCircuitHook).creationCode, abi.encode(PM, EVALUATOR, TAPEOUT, v, d, FEES, T, EPOCH)));
        uint256 salt;
        for (;; salt++) {
            address a = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), bytes32(salt), h)))));
            if (uint160(a) & ALL_HOOK_FLAGS == BEFORE_SWAP_FLAG) break;
        }
        try new FeeCircuitHook{salt: bytes32(salt)}(PM, EVALUATOR, TAPEOUT, v, d, FEES, T, EPOCH) {
            revert("expected revert");
        } catch (bytes memory reason) {
            return bytes4(reason);
        }
    }

    function _pool(address hook, uint128 liquidity) internal returns (PoolKey memory key) {
        key = PoolKey(Currency.wrap(address(t0)), Currency.wrap(address(t1)), LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(hook));
        PM.initialize(key, TickMath.getSqrtPriceAtTick(0));
        liqRouter.modifyLiquidity(key, ModifyLiquidityParams(-6000, 6000, int256(uint256(liquidity)), 0), "");
    }

    function _id(PoolKey memory key) internal pure returns (PoolId) {
        return key.toId();
    }

    /// Exact-input swap; returns the LP fee the PoolManager applied (from its Swap event).
    function _swapFee(PoolKey memory key, bool zeroForOne, uint256 amountIn) internal returns (uint24 fee) {
        vm.recordLogs();
        swapRouter.swap(
            key,
            SwapParams(zeroForOne, -int256(amountIn), zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(PM) && logs[i].topics[0] == SWAP_EVENT) {
                (,,,,, fee) = abi.decode(logs[i].data, (int128, int128, uint160, uint128, int24, uint24));
                return fee;
            }
        }
        revert("no Swap event");
    }

    /// Swaps until the pool reaches `target` tick; returns (amount paid in, amount received) in raw token units.
    function _swapToTick(PoolKey memory key, int24 target) internal returns (uint256 amountIn, uint256 amountOut) {
        (, int24 tick,,) = PM.getSlot0(_id(key));
        bool zeroForOne = target < tick;
        BalanceDelta d = swapRouter.swap(
            key, SwapParams(zeroForOne, -1e36, TickMath.getSqrtPriceAtTick(target)), PoolSwapTest.TestSettings(false, false), ""
        );
        int128 a0 = d.amount0();
        int128 a1 = d.amount1();
        (amountIn, amountOut) = zeroForOne ? (uint256(uint128(-a0)), uint256(uint128(a1))) : (uint256(uint128(-a1)), uint256(uint128(a0)));
    }

    function _sstore2Read(address pointer) internal view returns (bytes memory) {
        bytes memory code = pointer.code;
        bytes memory out = new bytes(code.length - 1);
        for (uint256 i = 1; i < code.length; i++) out[i - 1] = code[i];
        return out;
    }
}
