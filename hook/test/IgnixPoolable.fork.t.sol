// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {FeeCircuitHook} from "../src/FeeCircuitHook.sol";
import {FeeRouteHook} from "../src/FeeRouteHook.sol";
import {HookForkBase} from "./FeeCircuitHook.fork.t.sol";

interface IERC20P {
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// For every graduated Ignix launch that the tax survey found untaxed into the v4 PoolManager: a FeeRouteHook pool
/// (token / mock quote) on a local fork, liquidity, an exact-in buy and sell, and exact reconciliation of every amount
/// entering and leaving the PoolManager. Any tax in either direction breaks an equality (or v4 settlement).
contract IgnixPoolableForkTest is HookForkBase {
    uint160 internal constant ROUTE_FLAGS =
        uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG);
    uint16 internal constant ROUTE_BPS = 100;
    FeeCircuitHook.Guard internal splitGuard;
    FeeCircuitHook.Guard internal routeGuardC;
    address internal reserve = makeAddr("reserve");
    address internal holders = makeAddr("holderSink");

    event Result(string symbol, address token, bool ok, string detail);

    function setUp() public override {
        // Opt-in (minutes of fork reads; depends on live holder balances): IGNIX_SURVEY=true XLAYER_RPC_URL=... forge test --mc IgnixPoolableForkTest
        if (!vm.envOr("IGNIX_SURVEY", false)) vm.skip(true);
        super.setUp();
        string memory json = vm.readFile("test/fixtures/route-circuits.json");
        splitGuard = _tapeout(json, 0);
        routeGuardC = _tapeout(json, 1);
    }

    function test_untaxedIgnixTokensWorkInFeeRoutePools() public {
        string memory json = vm.readFile("test/fixtures/ignix-untaxed.json");
        uint256 n = vm.parseJsonUint(json, ".count");
        uint256 passed;
        for (uint256 i = 0; i < n; i++) {
            string memory p = string.concat(".tokens[", vm.toString(i), "]");
            address token = vm.parseJsonAddress(json, string.concat(p, ".token"));
            address holder = vm.parseJsonAddress(json, string.concat(p, ".holder"));
            string memory sym = vm.parseJsonString(json, string.concat(p, ".symbol"));
            try this.checkToken(token, holder) returns (string memory detail) {
                passed++;
                emit Result(sym, token, true, detail);
            } catch (bytes memory reason) {
                emit Result(sym, token, false, vm.toString(reason));
            }
        }
        emit log_named_uint("tokens that pool and reconcile exactly", passed);
        emit log_named_uint("of", n);
    }

    function checkToken(address token, address holder) external returns (string memory) {
        require(msg.sender == address(this));
        uint256 bal = IERC20P(token).balanceOf(holder);
        vm.prank(holder);
        IERC20P(token).transfer(address(this), bal / 2);
        uint256 have = IERC20P(token).balanceOf(address(this));
        require(have == bal / 2, "holder transfer taxed");

        // Pool: token vs a mock quote at price 1, liquidity sized to what we hold.
        address quote = address(t0) < token ? address(t0) : address(t1); // any mock works; keep a deterministic order
        (address c0, address c1) = quote < token ? (quote, token) : (token, quote);
        FeeRouteHook.RouteConfig memory r = FeeRouteHook.RouteConfig(
            splitGuard, routeGuardC, [reserve, holders, address(0), address(0)], ROUTE_BPS, Currency.wrap(token)
        );
        bytes memory init = abi.encodePacked(type(FeeRouteHook).creationCode, abi.encode(PM, EVALUATOR, TAPEOUT, volGuard, depthGuard, FEES, T, EPOCH, r));
        address hook = _deployWith(init, ROUTE_FLAGS);
        PoolKey memory key = PoolKey(Currency.wrap(c0), Currency.wrap(c1), LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(hook));
        IERC20P(token).approve(address(liqRouter), type(uint256).max);
        IERC20P(token).approve(address(swapRouter), type(uint256).max);
        PM.initialize(key, TickMath.getSqrtPriceAtTick(0));
        uint256 L = have / 4; // ±6000 ticks at price 1 uses ~0.26 L of each side
        uint256 pmTok = IERC20P(token).balanceOf(address(PM));
        liqRouter.modifyLiquidity(key, ModifyLiquidityParams(-6000, 6000, int256(L), 0), "");
        uint256 deposited = IERC20P(token).balanceOf(address(PM)) - pmTok;
        require(deposited > 0, "no token deposited");

        uint256 amt = L / 1000;
        bool buyIsZeroForOne = c1 == token; // buy = the swap outputs the token
        // Buy: token leaves the PoolManager. Swapper gets output - fee, reserve gets the fee, both in the token.
        uint256 me = IERC20P(token).balanceOf(address(this));
        uint256 res = IERC20P(token).balanceOf(reserve);
        uint256 pmBefore = IERC20P(token).balanceOf(address(PM));
        swapRouter.swap(key, SwapParams(buyIsZeroForOne, -int256(amt), buyIsZeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1), PoolSwapTest.TestSettings(false, false), "");
        uint256 got = IERC20P(token).balanceOf(address(this)) - me;
        uint256 fee = IERC20P(token).balanceOf(reserve) - res;
        require(pmBefore - IERC20P(token).balanceOf(address(PM)) == got + fee, "buy: PoolManager release != output + fee");
        require(fee == (got + fee) * ROUTE_BPS / 10_000, "buy: route fee != 1% of output");
        require(fee > 0, "buy: no fee routed");

        // Sell: token enters the PoolManager in full; fee in the quote goes to the holder sink.
        pmBefore = IERC20P(token).balanceOf(address(PM));
        me = IERC20P(token).balanceOf(address(this));
        uint256 hq = IERC20P(quote).balanceOf(holders);
        swapRouter.swap(key, SwapParams(!buyIsZeroForOne, -int256(amt), !buyIsZeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1), PoolSwapTest.TestSettings(false, false), "");
        require(IERC20P(token).balanceOf(address(PM)) - pmBefore == amt, "sell: PoolManager received != amount in");
        require(me - IERC20P(token).balanceOf(address(this)) == amt, "sell: swapper paid != amount in");
        require(IERC20P(quote).balanceOf(holders) > hq, "sell: no fee to holder sink");
        return string.concat("deposited ", vm.toString(deposited), " token units; buy fee ", vm.toString(fee));
    }
}
