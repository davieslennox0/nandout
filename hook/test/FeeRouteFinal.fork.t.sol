// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IProtocolFees} from "v4-core/src/interfaces/IProtocolFees.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {FixedPoint128} from "v4-core/src/libraries/FixedPoint128.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {FeeCircuitHook} from "../src/FeeCircuitHook.sol";
import {FeeRouteHook} from "../src/FeeRouteHook.sol";
import {HookForkBase, EvilCPU} from "./FeeCircuitHook.fork.t.sol";
import {ForcedRouteHook} from "./FeeRoute.fork.t.sol";

interface IOwnedPM { function owner() external view returns (address); }

/// @notice The exact configuration proposed for mainnet, on a local fork of X Layer:
///         generic token, every route to in-range LPs, route fee 5 bps, hook fee 1000 pips (v4's protocol-fee cap) of the
///         ACTUAL filled unspecified amount (FeeTakingHook model), paid to the Nandout deploy wallet; tiers 0.05/0.30/0.60/1.00%.
contract FeeRouteFinalForkTest is HookForkBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint160 internal constant FLAGS = uint160(
        Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
    );
    address internal constant RECIPIENT = 0x934d315C0a9C0866D393B722C1805F2B6b20b816; // Nandout deploy wallet
    uint16 internal constant ROUTE_BPS = 5;
    uint16 internal constant HOOK_FEE_PIPS = 1000;
    bytes32 internal constant ROUTED = keccak256("Routed(bytes32,uint8,address,address,uint256)");
    bytes32 internal constant HOOK_FEE = keccak256("HookFee(bytes32,address,address,uint256)");

    FeeCircuitHook.Guard internal splitGuard;
    FeeCircuitHook.Guard internal routeGuard;

    function setUp() public override {
        super.setUp();
        string memory json = vm.readFile("test/fixtures/route-circuits.json");
        splitGuard = _tapeout(json, 0);
        routeGuard = _tapeout(json, 1);
    }

    function _config() internal view returns (FeeRouteHook.RouteConfig memory) {
        return FeeRouteHook.RouteConfig(
            splitGuard, routeGuard, [address(0), address(0), address(0), address(0)], ROUTE_BPS, Currency.wrap(address(0)), HOOK_FEE_PIPS, RECIPIENT
        );
    }

    function _deployFinal(bytes memory creationCode) internal returns (address) {
        return _deployWith(abi.encodePacked(creationCode, abi.encode(PM, EVALUATOR, TAPEOUT, volGuard, depthGuard, FEES, T, EPOCH, _config())), FLAGS);
    }

    // ---- configuration --------------------------------------------------------------------------------------------

    function test_finalConfigAndAddressBits() public {
        FeeRouteHook hook = FeeRouteHook(_deployFinal(type(FeeRouteHook).creationCode));
        assertEq(uint160(address(hook)) & ALL_HOOK_FLAGS, FLAGS, "address encodes exactly beforeSwap, afterSwap, afterSwapReturnsDelta (0x..C4)");
        assertEq(hook.hookFeePips(), 1000);
        assertEq(hook.hookFeeRecipient(), RECIPIENT);
        assertEq(hook.routeBps(), 5);
        assertEq(Currency.unwrap(hook.token()), address(0), "generic");
        for (uint8 r = 0; r < 4; r++) assertEq(hook.destOf(r), address(0), "every route: in-range LPs");
        assertEq(hook.fee0(), 500);
        assertEq(hook.fee1(), 3000);
        assertEq(hook.fee2(), 6000);
        assertEq(hook.fee3(), 10000);
    }

    function test_hookFeeAboveCapOrWithoutRecipientIsRejected() public {
        FeeRouteHook.RouteConfig memory r = _config();
        r.hookFeePips = 1001;
        _expectDeployRevert(r, abi.encodeWithSelector(FeeRouteHook.BadHookFee.selector, uint16(1001), RECIPIENT));
        r = _config();
        r.hookFeeRecipient = address(0);
        _expectDeployRevert(r, abi.encodeWithSelector(FeeRouteHook.BadHookFee.selector, uint16(1000), address(0)));
    }

    // ---- the hook fee is 1000 pips of what actually filled --------------------------------------------------------

    /// Exact input: 1000 pips of the actual output. Exact output: 1000 pips of the actual input. Both directions.
    function test_hookFeeIsCapOfActualFill_bothModesBothDirections() public {
        FeeRouteHook hook = FeeRouteHook(_deployFinal(type(FeeRouteHook).creationCode));
        PoolKey memory key = _pool(address(hook), 1e24);
        for (uint256 d = 0; d < 2; d++) {
            bool z = d == 0;
            (Currency cin, Currency cout) = z ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
            // exact input -> fee in the output token, on the gross output
            uint256 rec = _bal(cout, RECIPIENT);
            uint256 out = _bal(cout, address(this));
            vm.recordLogs();
            _swapExactIn(key, z, 1_000e18);
            (, uint256 routeFee) = _routed(vm.getRecordedLogs());
            uint256 hookFee = _bal(cout, RECIPIENT) - rec;
            uint256 gross = _bal(cout, address(this)) - out + hookFee + routeFee;
            assertEq(hookFee, gross * 1000 / 1_000_000, "exact-in: 1000 pips of the actual output");
            // exact output -> fee in the input token, on the actual pool input
            rec = _bal(cin, RECIPIENT);
            uint256 paid = _bal(cin, address(this));
            vm.recordLogs();
            swapRouter.swap(key, SwapParams(z, 100e18, z ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1), PoolSwapTest.TestSettings(false, false), "");
            (, routeFee) = _routed(vm.getRecordedLogs());
            hookFee = _bal(cin, RECIPIENT) - rec;
            uint256 poolIn = paid - _bal(cin, address(this)) - hookFee - routeFee;
            assertEq(hookFee, poolIn * 1000 / 1_000_000, "exact-out: 1000 pips of the actual input");
        }
    }

    /// REGRESSION (deprecated hook 0x9553…40cc charged exact-input fees on the SPECIFIED amount): an exact-input swap with
    /// a price limit that fills only partly must pay the hook fee on what filled, and must not revert.
    function test_partialFillPaysHookFeeOnlyOnFilledAmount() public {
        FeeRouteHook hook = FeeRouteHook(_deployFinal(type(FeeRouteHook).creationCode));
        PoolKey memory key = _pool(address(hook), 1e24);
        uint256 me0 = t0.balanceOf(address(this));
        uint256 me1 = t1.balanceOf(address(this));
        uint256 rec1 = t1.balanceOf(RECIPIENT);
        uint256 rec0 = t0.balanceOf(RECIPIENT);
        vm.recordLogs();
        // Specify 1e30 of input, limit the price to 100 ticks away: only a small part can fill.
        swapRouter.swap(key, SwapParams(true, -1e30, TickMath.getSqrtPriceAtTick(-100)), PoolSwapTest.TestSettings(false, false), "");
        (, uint256 routeFee) = _routed(vm.getRecordedLogs());
        uint256 paidIn = me0 - t0.balanceOf(address(this));
        uint256 got = t1.balanceOf(address(this)) - me1;
        uint256 hookFee = t1.balanceOf(RECIPIENT) - rec1;
        assertLt(paidIn, 1e30 / 1e6, "partial fill: a tiny fraction of the specified amount was used");
        assertEq(t0.balanceOf(RECIPIENT), rec0, "no hook fee taken on the unfilled input");
        assertEq(hookFee, (got + hookFee + routeFee) * 1000 / 1_000_000, "fee = 1000 pips of the actual filled output");
        emit log_named_decimal_uint("specified input", 1e30, 18);
        emit log_named_decimal_uint("actually filled input", paidIn, 18);
        emit log_named_decimal_uint("hook fee (output token), on the filled amount only", hookFee, 18);
    }

    /// For the record: value of the hook fee vs. v4's own protocol fee at 1000 pips on an identical pool (exact input).
    function test_hookFeeValueVsV4ProtocolFee() public {
        FeeRouteHook hook = FeeRouteHook(_deployFinal(type(FeeRouteHook).creationCode));
        PoolKey memory ours = _pool(address(hook), 1e24);
        PoolKey memory ref = PoolKey(Currency.wrap(address(t0)), Currency.wrap(address(t1)), 3000, 60, IHooks(address(0)));
        PM.initialize(ref, TickMath.getSqrtPriceAtTick(0));
        liqRouter.modifyLiquidity(ref, ModifyLiquidityParams(-6000, 6000, 1e24, 0), "");
        vm.prank(IOwnedPM(address(PM)).owner());
        IProtocolFees(address(PM)).setProtocolFeeController(address(this));
        IProtocolFees(address(PM)).setProtocolFee(ref, uint24(1000) | (uint24(1000) << 12));
        uint256 rec = t1.balanceOf(RECIPIENT);
        _swapExactIn(ours, true, 1_000e18);
        uint256 hookFeeOut = t1.balanceOf(RECIPIENT) - rec;
        uint256 acc = IProtocolFees(address(PM)).protocolFeesAccrued(ref.currency0);
        _swapExactIn(ref, true, 1_000e18);
        uint256 protoFeeIn = IProtocolFees(address(PM)).protocolFeesAccrued(ref.currency0) - acc;
        emit log_named_decimal_uint("hook fee, output token (1000 pips of actual output)", hookFeeOut, 18);
        emit log_named_decimal_uint("v4 protocol fee, input token (1000 pips of input)", protoFeeIn, 18);
        // Same 1000-pip rate; the hook's base is the output (after LP fee and price impact), so it is slightly smaller.
        assertLt(hookFeeOut, protoFeeIn);
        assertGt(hookFeeOut, protoFeeIn * 99 / 100);
    }

    /// The number to confirm before deploying: a 1,000-token exact-input swap in a pool whose circuit tier is 0.30%.
    function test_workedExample_1000TokensAt030Tier() public {
        ForcedRouteHook hook = ForcedRouteHook(_deployFinal(type(ForcedRouteHook).creationCode));
        hook.force(4); // tier 1 = 0.30%
        PoolKey memory key = _pool(address(hook), 1e24);
        PoolId id = key.toId();
        uint128 liq = PM.getLiquidity(id);
        (uint256 fg0, uint256 fg1) = PM.getFeeGrowthGlobals(id);
        uint256 me0 = t0.balanceOf(address(this));
        uint256 me1 = t1.balanceOf(address(this));
        uint256 rec = t1.balanceOf(RECIPIENT);
        vm.recordLogs();
        _swapExactIn(key, true, 1_000e18);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (, uint256 routeFee) = _routed(logs);
        uint24 lpFeeApplied = _swapEventFee(logs);
        (uint256 fg0b, uint256 fg1b) = PM.getFeeGrowthGlobals(id);
        uint256 lpFee0 = FullMath.mulDiv(fg0b - fg0, liq, FixedPoint128.Q128); // LP fee, in the input token
        uint256 donated1 = FullMath.mulDiv(fg1b - fg1, liq, FixedPoint128.Q128); // route fee to LPs, in the output token

        emit log_named_decimal_uint("trader pays (input token)", me0 - t0.balanceOf(address(this)), 18);
        emit log_named_decimal_uint("hook fee -> Nandout deploy wallet (1000 pips of actual output, output token)", t1.balanceOf(RECIPIENT) - rec, 18);
        emit log_named_uint("  LP fee applied by the PoolManager, pips", lpFeeApplied);
        emit log_named_decimal_uint("  LP fee to in-range LPs (0.30% of the 1,000 input)", lpFee0, 18);
        emit log_named_decimal_uint("route fee -> in-range LPs (5 bps of output, output token)", routeFee, 18);
        emit log_named_decimal_uint("trader receives (output token)", t1.balanceOf(address(this)) - me1, 18);

        assertEq(lpFeeApplied, 3000);
        assertApproxEqAbs(lpFee0, 3e18, 1e6, "0.30% of 1,000");
        assertApproxEqAbs(donated1, routeFee, 1e6);
    }

    // ---- headline: a hostile TapeOut upgrade changes neither the tier nor the destination ----------------------------

    function test_maliciousTapeOutUpgradeCannotChangeTierOrDestination() public {
        ForcedRouteHook hook = ForcedRouteHook(_deployFinal(type(ForcedRouteHook).creationCode));
        PoolKey memory key = _pool(address(hook), 1e24);
        uint24[64] memory lpFee;
        uint8[64] memory route;
        for (uint8 f = 0; f < 32; f++) {
            hook.force(f);
            for (uint256 d = 0; d < 2; d++) (lpFee[f * 2 + d], route[f * 2 + d]) = _observe(key, d == 0);
        }
        uint64 tierTable = hook.table();
        uint64 routeTable = hook.routeTable();

        vm.etch(PROCESSOR, type(EvilCPU).runtimeCode);
        assertEq(uint8(ICPUView(PROCESSOR).eval(volGuard.circuitId, abi.encodePacked(uint8(0), uint8(0)))[0]), 1, "live path compromised");

        for (uint8 f = 0; f < 32; f++) {
            hook.force(f);
            for (uint256 d = 0; d < 2; d++) {
                (uint24 fee, uint8 r) = _observe(key, d == 0);
                assertEq(fee, lpFee[f * 2 + d], "LP fee tier unchanged");
                assertEq(r, route[f * 2 + d], "route unchanged");
            }
        }
        assertEq(hook.table(), tierTable);
        assertEq(hook.routeTable(), routeTable);
        for (uint8 r = 0; r < 4; r++) assertEq(hook.destOf(r), address(0), "destinations immutable: LPs");
        assertEq(hook.hookFeeRecipient(), RECIPIENT);
    }

    // ---- helpers ----------------------------------------------------------------------------------------------------

    function _observe(PoolKey memory key, bool z) internal returns (uint24 fee, uint8 route) {
        uint256 rec = _bal(z ? key.currency1 : key.currency0, RECIPIENT);
        vm.recordLogs();
        _swapExactIn(key, z, 1e17);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        fee = _swapEventFee(logs);
        (route,) = _routed(logs);
        require(_bal(z ? key.currency1 : key.currency0, RECIPIENT) > rec, "hook fee paid");
    }

    function _swapExactIn(PoolKey memory key, bool z, uint256 amt) internal {
        swapRouter.swap(key, SwapParams(z, -int256(amt), z ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1), PoolSwapTest.TestSettings(false, false), "");
    }

    function _routed(Vm.Log[] memory logs) internal pure returns (uint8 route, uint256 amount) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == ROUTED) {
                (uint8 r,,, uint256 a) = abi.decode(logs[i].data, (uint8, address, address, uint256));
                return (r, a);
            }
        }
        revert("no Routed event");
    }

    function _swapEventFee(Vm.Log[] memory logs) internal view returns (uint24 fee) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(PM) && logs[i].topics[0] == SWAP_EVENT) {
                (,,,,, fee) = abi.decode(logs[i].data, (int128, int128, uint160, uint128, int24, uint24));
                return fee;
            }
        }
        revert("no Swap event");
    }

    function _bal(Currency c, address who) internal view returns (uint256) {
        return Currency.unwrap(c) == address(t0) ? t0.balanceOf(who) : t1.balanceOf(who);
    }

    function _expectDeployRevert(FeeRouteHook.RouteConfig memory r, bytes memory err) internal {
        bytes memory init = abi.encodePacked(type(FeeRouteHook).creationCode, abi.encode(PM, EVALUATOR, TAPEOUT, volGuard, depthGuard, FEES, T, EPOCH, r));
        bytes32 h = keccak256(init);
        uint256 salt;
        for (;; salt++) {
            address a = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), bytes32(salt), h)))));
            if (uint160(a) & ALL_HOOK_FLAGS == FLAGS) break;
        }
        (bool ok, bytes memory ret) = address(this).call(abi.encodeCall(this.create2Raw, (init, salt)));
        assertFalse(ok);
        assertEq(ret, err);
    }

    function create2Raw(bytes memory init, uint256 salt) external {
        assembly {
            let got := create2(0, add(init, 0x20), mload(init), salt)
            if iszero(got) {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
        }
    }
}

interface ICPUView { function eval(uint256, bytes calldata) external view returns (bytes memory); }
