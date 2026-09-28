// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";

interface IERC20 {
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// Pre-deploy check (2026-09-28): can IGNIXFROG / wQQQx live in a v4 pool on X Layer? No. IGNIXFROG (an Ignix
/// launch) takes 3% on transfers to/from its v2 pair AND to/from the v4 PoolManager, while transfers to ordinary
/// addresses and to LatchLock are untaxed. v4 settles exact amounts, so any v4 pool holding it fails with
/// CurrencyNotSettled, with or without a hook. These tests pin that finding.
contract IgnixFrogPoolForkTest is Test {
    IPoolManager constant PM = IPoolManager(0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32);
    address constant FROG = 0x972Af7f810b407A099e733515bE26b54F2c1eeeE;
    address constant WQQQX = 0x4C1AE29c159838fC1b224636E28E086EB69101f7;
    address constant PAIR = 0xdDbc9576bf69F89D2Fc9FaDCED95D5Bb835F3098;

    function setUp() public {
        string memory rpc = vm.envOr("XLAYER_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);
    }

    function _received(address token, address from, address to, uint256 amt) internal returns (uint256) {
        uint256 b = IERC20(token).balanceOf(to);
        vm.prank(from);
        IERC20(token).transfer(to, amt);
        return IERC20(token).balanceOf(to) - b;
    }

    function test_transferTaxProbe() public {
        // Balances at the fork block; the pair holds plenty of both tokens.
        address user = makeAddr("user");
        assertEq(_received(FROG, PAIR, user, 1e24), 0.97e24, "3% on transfers from the pair");
        emit log_named_uint("FROG pair -> user (a 'buy' leg), sent 1e24, received", _received(FROG, PAIR, user, 1e24));
        assertEq(_received(FROG, user, address(PM), 1e23), 0.97e23, "3% on transfers into the v4 PoolManager");
        emit log_named_uint("FROG user -> PAIR (a 'sell' leg), sent 1e23, received", _received(FROG, user, PAIR, 1e23));
        assertEq(_received(FROG, user, 0xBe9ae981ec742B9053AD802a1D6A2B96E58b67f1, 1e23), 1e23, "untaxed into LatchLock");
        address earlierHolder = 0x8DF1fB955D92AEa868954104FAF66b81dB71b9AD; // the holder used in the 2026-09-27 lock diagnosis
        emit log_named_uint("FROG earlier holder -> user, sent 1e23, received", _received(FROG, earlierHolder, makeAddr("u2"), 1e23));
        emit log_named_uint("wQQQx pair -> user, sent 1e18, received", _received(WQQQX, PAIR, user, 1e18));
        emit log_named_uint("wQQQx user -> PoolManager, sent 1e17, received", _received(WQQQX, user, address(PM), 1e17));
    }

    function test_plainV4PoolFailsOnIgnixTax() public {
        (address c0, address c1) = WQQQX < FROG ? (WQQQX, FROG) : (FROG, WQQQX);
        vm.startPrank(PAIR);
        IERC20(FROG).transfer(address(this), 5e24);
        IERC20(WQQQX).transfer(address(this), 2e18);
        vm.stopPrank();
        PoolSwapTest swapR = new PoolSwapTest(PM);
        PoolModifyLiquidityTest liqR = new PoolModifyLiquidityTest(PM);
        IERC20(c0).approve(address(swapR), type(uint256).max); IERC20(c1).approve(address(swapR), type(uint256).max);
        IERC20(c0).approve(address(liqR), type(uint256).max); IERC20(c1).approve(address(liqR), type(uint256).max);
        // price = FROG per wQQQx from the v2 reserves: 90.37M / 22.88 ≈ 3.95M -> tick ≈ ln(3.95e6)/ln(1.0001) ≈ 151,900
        PoolKey memory key = PoolKey(Currency.wrap(c0), Currency.wrap(c1), 3000, 60, IHooks(address(0)));
        PM.initialize(key, TickMath.getSqrtPriceAtTick(151_860));
        vm.expectRevert(IPoolManager.CurrencyNotSettled.selector);
        liqR.modifyLiquidity(key, ModifyLiquidityParams(140_040, 163_680, 1e21, 0), "");
        // (the add-liquidity above only succeeds for the untaxed side; settling FROG into the PoolManager loses 3%)
    }
}
