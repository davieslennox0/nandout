// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {ProtocolFeeLibrary} from "v4-core/src/libraries/ProtocolFeeLibrary.sol";
import {ICircuitRegistryView, ILatchEvaluator} from "latch/interfaces/ILatch.sol";
import {FeeCircuitHook} from "./FeeCircuitHook.sol";

/// @title FeeRouteHook: a circuit chooses where a swap's route fee goes.
/// @notice FeeCircuitHook's circuits choose the LP fee *level*. FeeRouteHook adds a fixed route fee (`routeBps`, taken
///         on the unspecified side of every swap) and two more taped-out circuits choose its *destination* from four
///         addresses fixed at deploy:
///
///           route = (ROUTE_GUARD << 1) | ROUTE_SPLIT
///           ROUTE_SPLIT = NOT IS_BUY               -> calm buys to route 0 (reserve), calm sells to route 1 (holders)
///           ROUTE_GUARD = VOL_HIGH OR DEPTH_THIN   -> routes 2/3 (LPs) whenever LPs are most at risk
///
///         Facts are IS_BUY (swap direction, from the params) plus the same windowed VOL_HIGH / DEPTH_THIN the tier
///         circuits use. As with the tier, all 32 answers are computed once in the constructor by Nandout's
///         LatchEvaluator on frozen netlists and stored as an immutable table. Nobody, including the deployer, can change
///         the destinations or the mapping afterwards, and a TapeOut upgrade cannot redirect fees (the hook never calls
///         TapeOut after construction).
///
///         Accounting: afterSwap returns the fee as the hook's unspecified delta (the swapper pays it) and resolves the
///         hook's own delta in the same callback, with `take` to the destination or `donate` to in-range LPs.
///         A destination of address(0) means "in-range LPs". With every destination set to LPs and `token` set to
///         Currency(0), the hook is generic: any pool may use it, and every pool's route fee goes to that pool's own LPs.
contract FeeRouteHook is FeeCircuitHook {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    struct RouteConfig {
        Guard split; // ROUTE_SPLIT circuit
        Guard guard; // ROUTE_GUARD circuit
        address[4] dests; // address(0) = donate to in-range LPs
        uint16 routeBps; // route fee, basis points of the unspecified amount (<= 1000)
        Currency token; // the traded token (a swap that outputs it is a buy); Currency(0) = generic: a buy acquires currency1
        uint16 hookFeePips; // hook fee in v4 pips (1e-6) of the ACTUAL filled unspecified amount; <= 1000 (v4's protocol-fee cap)
        address hookFeeRecipient; // the only non-LP recipient; immutable
    }

    address public immutable routeSplitNetlist;
    address public immutable routeGuardNetlist;
    uint64 public immutable routeTable; // route for route-fact word f = (routeTable >> 2f) & 3
    address public immutable dest0;
    address public immutable dest1;
    address public immutable dest2;
    address public immutable dest3;
    uint16 public immutable routeBps;
    Currency public immutable token;
    uint16 public immutable hookFeePips;
    address public immutable hookFeeRecipient;
    uint256 internal constant PIPS = 1_000_000;

    /// Transient slot carrying the route chosen in beforeSwap (pre-swap facts) to afterSwap.
    uint256 internal constant ROUTE_SLOT = uint256(keccak256("nandout.feeroute.route")) - 1;

    event Routed(PoolId indexed id, uint8 route, address dest, Currency currency, uint256 amount);
    event HookFee(PoolId indexed id, address recipient, Currency currency, uint256 amount);

    error BadRouteFee(uint16 routeBps);
    error TokenNotInPool();
    error BadHookFee(uint16 pips, address recipient);

    constructor(
        IPoolManager poolManager_,
        ILatchEvaluator evaluator_,
        ICircuitRegistryView tapeout,
        Guard memory volGuard,
        Guard memory depthGuard,
        uint24[4] memory fees,
        Thresholds memory t,
        uint32 epochBlocks_,
        RouteConfig memory r
    ) FeeCircuitHook(poolManager_, evaluator_, tapeout, volGuard, depthGuard, fees, t, epochBlocks_) {
        if (r.routeBps == 0 || r.routeBps > 1000) revert BadRouteFee(r.routeBps);
        if (r.hookFeePips > ProtocolFeeLibrary.MAX_PROTOCOL_FEE || (r.hookFeePips > 0) != (r.hookFeeRecipient != address(0))) {
            revert BadHookFee(r.hookFeePips, r.hookFeeRecipient);
        }
        address sp = _snapshot(evaluator_, tapeout, r.split);
        address gp = _snapshot(evaluator_, tapeout, r.guard);
        uint64 tbl;
        for (uint256 f = 0; f < N_FACT_WORDS; f++) {
            (bool s,) = evaluator_.evaluate(sp, "", uint16(f));
            (bool g,) = evaluator_.evaluate(gp, "", uint16(f));
            tbl |= uint64((g ? 2 : 0) | (s ? 1 : 0)) << uint64(2 * f);
        }
        routeSplitNetlist = sp;
        routeGuardNetlist = gp;
        routeTable = tbl;
        (dest0, dest1, dest2, dest3) = (r.dests[0], r.dests[1], r.dests[2], r.dests[3]);
        routeBps = r.routeBps;
        token = r.token;
        hookFeePips = r.hookFeePips;
        hookFeeRecipient = r.hookFeeRecipient;
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory p) {
        p.beforeSwap = true;
        p.afterSwap = true;
        p.afterSwapReturnDelta = true;
    }

    // ---- views --------------------------------------------------------------------------------------------------

    function routeOf(uint8 routeFacts) public view returns (uint8) {
        return uint8((routeTable >> (2 * uint256(routeFacts & 31))) & 3);
    }

    function destOf(uint8 route) public view returns (address) {
        return route == 0 ? dest0 : route == 1 ? dest1 : route == 2 ? dest2 : dest3;
    }

    /// @notice Route-fact word: bit 0 IS_BUY, bit 1 VOL_HIGH, bit 2 DEPTH_THIN (from the tier fact word).
    function routeFactsOf(bool isBuy, uint8 tierFacts) public pure returns (uint8 f) {
        if (isBuy) f |= 1;
        if (tierFacts & VOL_HIGH != 0) f |= 2;
        if (tierFacts & DEPTH_THIN != 0) f |= 4;
    }

    // ---- hook ---------------------------------------------------------------------------------------------------

    function _onFacts(PoolKey calldata key, SwapParams calldata params, uint8 facts) internal override {
        bool isBuy;
        if (Currency.unwrap(token) == address(0)) isBuy = params.zeroForOne; // generic: any pool; buy = acquire currency1
        else if (Currency.unwrap(key.currency1) == Currency.unwrap(token)) isBuy = params.zeroForOne;
        else if (Currency.unwrap(key.currency0) == Currency.unwrap(token)) isBuy = !params.zeroForOne;
        else revert TokenNotInPool();
        uint256 v = uint256(routeOf(routeFactsOf(isBuy, facts))) + 1;
        uint256 slot = ROUTE_SLOT;
        assembly ("memory-safe") { tstore(slot, v) }
    }

    function afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        external
        override
        returns (bytes4, int128)
    {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        uint256 slot = ROUTE_SLOT;
        uint256 v;
        assembly ("memory-safe") {
            v := tload(slot)
            tstore(slot, 0)
        }
        uint8 route = uint8(v - 1); // beforeSwap always runs first for this hook; v == 0 would underflow and revert

        PoolId id = key.toId();
        bool specifiedIs0 = (params.amountSpecified < 0 == params.zeroForOne);
        (Currency c, int128 amt) = specifiedIs0 ? (key.currency1, delta.amount1()) : (key.currency0, delta.amount0());
        if (amt < 0) amt = -amt;
        uint256 unspecified = uint256(uint128(amt));

        // 1. Hook fee on the ACTUAL filled unspecified amount (output of exact-in, input of exact-out), like v4-core's
        //    FeeTakingHook. afterSwap can only charge the unspecified side; charging exact-in input upfront in beforeSwap
        //    overcharged partial fills (the deprecated 0x9553…40cc), so the fee is taken here, after the fill is known.
        uint256 hookFee = unspecified * hookFeePips / PIPS;
        int128 hookDelta;
        if (hookFee > 0) {
            poolManager.take(c, hookFeeRecipient, hookFee);
            emit HookFee(id, hookFeeRecipient, c, hookFee);
            hookDelta = int128(int256(hookFee));
        }

        // 2. Route fee, on the unspecified side (as v4-core's FeeTakingHook), sent where the circuit's route says.
        uint256 fee = unspecified * routeBps / 10_000;
        if (fee > 0) {
            address dest = destOf(route);
            if (dest == address(0)) {
                // To in-range LPs. The hook's credit pays for the donation, so its net delta is zero.
                if (poolManager.getLiquidity(id) == 0) return (IHooks.afterSwap.selector, hookDelta);
                bool is0 = Currency.unwrap(c) == Currency.unwrap(key.currency0);
                poolManager.donate(key, is0 ? fee : 0, is0 ? 0 : fee, "");
            } else {
                poolManager.take(c, dest, fee);
            }
            emit Routed(id, route, dest, c, fee);
            hookDelta += int128(int256(fee));
        }
        return (IHooks.afterSwap.selector, hookDelta);
    }
}
