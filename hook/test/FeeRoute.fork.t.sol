// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {FixedPoint128} from "v4-core/src/libraries/FixedPoint128.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {ICPU} from "latch/vendor/tapeout/interfaces/ICPU.sol";
import {ICircuitRegistryView, ILatchEvaluator} from "latch/interfaces/ILatch.sol";
import {FeeCircuitHook} from "../src/FeeCircuitHook.sol";
import {FeeRouteHook} from "../src/FeeRouteHook.sol";
import {HookForkBase, EvilCPU} from "./FeeCircuitHook.fork.t.sol";

/// Test-only: tier facts forced from storage, so every route-fact word can be driven through real swaps.
contract ForcedRouteHook is FeeRouteHook {
    uint8 public forced;

    constructor(
        IPoolManager pm,
        ILatchEvaluator ev,
        ICircuitRegistryView reg,
        Guard memory v,
        Guard memory d,
        uint24[4] memory fees,
        Thresholds memory t,
        uint32 epoch,
        RouteConfig memory r
    ) FeeRouteHook(pm, ev, reg, v, d, fees, t, epoch, r) {}

    function force(uint8 f) external { forced = f; }

    function _facts(PoolKey calldata) internal view override returns (uint8) { return forced; }
}

/// @notice FeeRouteHook on a local fork of X Layer mainnet: real PoolManager, Nandout processor and LatchEvaluator.
contract FeeRouteForkTest is HookForkBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint160 internal constant ROUTE_FLAGS =
        uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG);
    bytes32 internal constant ROUTED = keccak256("Routed(bytes32,uint8,address,address,uint256)");
    uint16 internal constant ROUTE_BPS = 100; // 1% route fee (large, so every rounding step is visible)

    FeeCircuitHook.Guard internal splitGuard;
    FeeCircuitHook.Guard internal routeGuard;
    uint8[32] internal fixtureRoutes;
    address internal reserve = makeAddr("reserve"); // route 0
    address internal holders = makeAddr("holderSink"); // route 1

    function setUp() public override {
        super.setUp();
        string memory json = vm.readFile("test/fixtures/route-circuits.json");
        splitGuard = _tapeout(json, 0);
        routeGuard = _tapeout(json, 1);
        for (uint256 f = 0; f < 32; f++) fixtureRoutes[f] = uint8(vm.parseJsonUint(json, string.concat(".routes[", vm.toString(f), "]")));
    }

    // ---- the table is the circuits' complete output ---------------------------------------------------------------

    function test_routeTableEqualsLiveTapeOutEvalForEveryFactWord() public {
        FeeRouteHook hook = _deployRoute(type(FeeRouteHook).creationCode);
        for (uint8 f = 0; f < 32; f++) {
            uint8 live = _liveRoute(f);
            assertEq(hook.routeOf(f), live, "route table == TapeOut live eval");
            assertEq(live, fixtureRoutes[f], "TapeOut live eval == DSL");
            (bool s,) = EVALUATOR.evaluate(hook.routeSplitNetlist(), "", f);
            (bool g,) = EVALUATOR.evaluate(hook.routeGuardNetlist(), "", f);
            assertEq((g ? 2 : 0) | (s ? 1 : 0), live, "frozen netlist on LatchEvaluator == live eval");
        }
    }

    // ---- real swaps reconcile exactly ------------------------------------------------------------------------------

    function test_buysToReserveSellsToHoldersReconcileExactly() public {
        FeeRouteHook hook = _deployRoute(type(FeeRouteHook).creationCode);
        PoolKey memory key = _pool(address(hook), 1e23); // deep and calm -> ROUTE_GUARD off
        assertEq(Currency.unwrap(hook.token()), address(t1), "t1 is the traded token: zeroForOne = buy");

        // Buy, exact input: 1 t0 in, fee taken from the t1 output and sent to the reserve.
        (uint256 got, uint256 fee, uint256 pmOut) = _exactIn(key, true, 1e18, reserve);
        assertEq(fee, (got + fee) * ROUTE_BPS / 10_000, "fee = 1% of the pool's output");
        assertEq(pmOut, got + fee, "PoolManager paid out exactly output + fee");
        assertEq(t0.balanceOf(holders) + t1.balanceOf(holders), 0, "nothing to the holder sink on a buy");

        // Sell, exact input: 1 t1 in, fee taken from the t0 output and sent to the holder sink.
        (got, fee, pmOut) = _exactIn(key, false, 1e18, holders);
        assertEq(fee, (got + fee) * ROUTE_BPS / 10_000);
        assertEq(pmOut, got + fee);

        // Buy, exact output: 0.5 t1 out, fee charged on top of the t0 input and sent to the reserve.
        uint256 r0 = t0.balanceOf(reserve);
        uint256 me0 = t0.balanceOf(address(this));
        uint256 me1 = t1.balanceOf(address(this));
        swapRouter.swap(key, SwapParams(true, 0.5e18, TickMath.MIN_SQRT_PRICE + 1), PoolSwapTest.TestSettings(false, false), "");
        uint256 paid = me0 - t0.balanceOf(address(this));
        uint256 feeIn = t0.balanceOf(reserve) - r0;
        assertEq(t1.balanceOf(address(this)) - me1, 0.5e18, "exact output delivered in full");
        assertEq(feeIn, (paid - feeIn) * ROUTE_BPS / 10_000, "fee = 1% of the pool's input, paid on top");
    }

    function test_guardRoutesFeeToLpsAndReconciles() public {
        FeeRouteHook hook = _deployRoute(type(FeeRouteHook).creationCode);
        PoolKey memory key = _pool(address(hook), 5e21); // thin -> DEPTH_THIN -> ROUTE_GUARD on
        PoolId id = key.toId();
        (uint256 fg0Before,) = PM.getFeeGrowthGlobals(id);
        uint128 liq = PM.getLiquidity(id);
        uint256 pm0 = t0.balanceOf(address(PM));
        uint256 me0 = t0.balanceOf(address(this));

        vm.recordLogs();
        // Sell: t1 in (the LP fee accrues in t1), fee on the t0 output -> donated in t0, so fee growth 0 is the donation.
        swapRouter.swap(key, SwapParams(false, -1e18, TickMath.MAX_SQRT_PRICE - 1), PoolSwapTest.TestSettings(false, false), "");
        (uint8 route, address dest,, uint256 fee) = _routed(vm.getRecordedLogs());
        (uint256 fg0After,) = PM.getFeeGrowthGlobals(id);
        uint256 got = t0.balanceOf(address(this)) - me0;

        assertEq(route, 3, "guarded sell -> route 3");
        assertEq(dest, address(0), "route 3 = in-range LPs");
        assertEq(t0.balanceOf(reserve) + t0.balanceOf(holders) + t1.balanceOf(reserve) + t1.balanceOf(holders), 0);
        assertEq(pm0 - t0.balanceOf(address(PM)), got, "only the swapper's output left the PoolManager; the fee stayed with LPs");
        assertEq(fee, (got + fee) * ROUTE_BPS / 10_000);
        assertEq(fg0After - fg0Before, FullMath.mulDiv(fee, FixedPoint128.Q128, liq), "fee growth rose by exactly the donated fee");
    }

    // ---- headline: a hostile TapeOut upgrade cannot redirect fees --------------------------------------------------

    function test_maliciousTapeOutUpgradeCannotRedirectFees() public {
        ForcedRouteHook hook = ForcedRouteHook(address(_deployRoute(type(ForcedRouteHook).creationCode)));
        PoolKey memory key = _pool(address(hook), 1e23);
        uint8[4] memory tierFacts = [uint8(0), 1, 4, 5]; // calm, VOL_HIGH, DEPTH_THIN, both
        uint8[8] memory before;
        address[8] memory beforeDest;
        for (uint256 i = 0; i < 8; i++) {
            hook.force(tierFacts[i / 2]);
            (before[i], beforeDest[i]) = _swapRoute(key, i % 2 == 0);
        }
        assertEq(beforeDest[0], reserve, "calm buy -> reserve");
        assertEq(beforeDest[1], holders, "calm sell -> holders");
        for (uint256 i = 2; i < 8; i++) assertEq(beforeDest[i], address(0), "guarded -> LPs");
        uint64 tableBefore = hook.routeTable();

        // Every live eval now passes and every netlist is garbage.
        vm.etch(PROCESSOR, type(EvilCPU).runtimeCode);
        assertEq(uint8(ICPU(PROCESSOR).eval(splitGuard.circuitId, abi.encodePacked(uint8(1), uint8(0)))[0]), 1, "live path now claims a calm buy is a sell");

        for (uint256 i = 0; i < 8; i++) {
            hook.force(tierFacts[i / 2]);
            (uint8 r, address d) = _swapRoute(key, i % 2 == 0);
            assertEq(r, before[i], "route unchanged after the upgrade");
            assertEq(d, beforeDest[i], "destination unchanged after the upgrade");
        }
        assertEq(hook.routeTable(), tableBefore);
    }

    function test_rejectsRouteFeeOutOfRange() public {
        FeeRouteHook.RouteConfig memory r = _routeConfig();
        r.routeBps = 1001;
        bytes memory init = abi.encodePacked(type(FeeRouteHook).creationCode, abi.encode(PM, EVALUATOR, TAPEOUT, volGuard, depthGuard, FEES, T, EPOCH, r));
        (bool ok, bytes memory ret) = address(this).call(abi.encodeCall(this.deployRaw, (init)));
        assertFalse(ok);
        assertEq(bytes4(ret), FeeRouteHook.BadRouteFee.selector);
    }

    function deployRaw(bytes memory init) external returns (address) {
        return _deployWithRevert(init, ROUTE_FLAGS);
    }

    // ---- helpers ----------------------------------------------------------------------------------------------------

    function _routeConfig() internal view returns (FeeRouteHook.RouteConfig memory) {
        return FeeRouteHook.RouteConfig(splitGuard, routeGuard, [reserve, holders, address(0), address(0)], ROUTE_BPS, Currency.wrap(address(t1)));
    }

    function _deployRoute(bytes memory creationCode) internal returns (FeeRouteHook) {
        bytes memory init = abi.encodePacked(creationCode, abi.encode(PM, EVALUATOR, TAPEOUT, volGuard, depthGuard, FEES, T, EPOCH, _routeConfig()));
        return FeeRouteHook(_deployWith(init, ROUTE_FLAGS));
    }

    function _deployWithRevert(bytes memory init, uint160 flags) internal returns (address addr) {
        bytes32 h = keccak256(init);
        uint256 salt;
        for (;; salt++) {
            addr = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), bytes32(salt), h)))));
            if (uint160(addr) & ALL_HOOK_FLAGS == flags) break;
        }
        address got;
        assembly {
            got := create2(0, add(init, 0x20), mload(init), salt)
            if iszero(got) {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
        }
    }

    function _liveRoute(uint8 f) internal view returns (uint8) {
        bytes memory in_ = abi.encodePacked(f, uint8(0));
        uint8 s = uint8(ICPU(PROCESSOR).eval(splitGuard.circuitId, in_)[0]) & 1;
        uint8 g = uint8(ICPU(PROCESSOR).eval(routeGuard.circuitId, in_)[0]) & 1;
        return (g << 1) | s;
    }

    /// Exact-input swap; returns (swapper received, fee received by `sink`, amount that left the PoolManager).
    function _exactIn(PoolKey memory key, bool zeroForOne, uint256 amountIn, address sink)
        internal
        returns (uint256 got, uint256 fee, uint256 pmOut)
    {
        (Currency cOut) = zeroForOne ? key.currency1 : key.currency0;
        address out = Currency.unwrap(cOut);
        uint256 me = _bal(out, address(this));
        uint256 s = _bal(out, sink);
        uint256 pm = _bal(out, address(PM));
        swapRouter.swap(key, SwapParams(zeroForOne, -int256(amountIn), zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1), PoolSwapTest.TestSettings(false, false), "");
        got = _bal(out, address(this)) - me;
        fee = _bal(out, sink) - s;
        pmOut = pm - _bal(out, address(PM));
    }

    function _swapRoute(PoolKey memory key, bool buy) internal returns (uint8 route, address dest) {
        vm.recordLogs();
        swapRouter.swap(key, SwapParams(buy, -1e17, buy ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1), PoolSwapTest.TestSettings(false, false), "");
        (route, dest,,) = _routed(vm.getRecordedLogs());
    }

    function _routed(Vm.Log[] memory logs) internal pure returns (uint8 route, address dest, address currency, uint256 amount) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == ROUTED) return abi.decode(logs[i].data, (uint8, address, address, uint256));
        }
        revert("no Routed event");
    }

    function _bal(address token, address who) internal view returns (uint256) {
        return token == address(t0) ? t0.balanceOf(who) : t1.balanceOf(who);
    }
}
