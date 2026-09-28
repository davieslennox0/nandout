// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IProtocolFees} from "v4-core/src/interfaces/IProtocolFees.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

interface IOwned { function owner() external view returns (address); }

/// @notice Phase 0 recon claims, re-checked on every CI run against a local fork of X Layer mainnet (docs/HOOK-RECON.md).
contract ReconForkTest is Test {
    address internal constant POOL_MANAGER = 0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32;
    address internal constant CANONICAL_ETH_POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;

    function setUp() public {
        string memory rpc = vm.envOr("XLAYER_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);
    }

    /// X Layer's PoolManager is byte-identical to Uniswap's canonical Ethereum deployment except the 20-byte
    /// NoDelegateCall self-address immutable, i.e. it is released v4-core, unmodified.
    function test_poolManagerIsCanonicalV4Core() public {
        bytes memory live = POOL_MANAGER.code;
        vm.createSelectFork(vm.envOr("ETH_RPC_URL", string("https://ethereum-rpc.publicnode.com")));
        bytes memory canonical = CANONICAL_ETH_POOL_MANAGER.code;
        assertEq(live.length, canonical.length, "same length");
        bytes20 eth = bytes20(CANONICAL_ETH_POOL_MANAGER);
        bytes20 xl = bytes20(POOL_MANAGER);
        uint256 replaced;
        for (uint256 i = 0; i + 20 <= canonical.length; i++) {
            bool hit = true;
            for (uint256 j = 0; j < 20; j++) if (canonical[i + j] != eth[j]) { hit = false; break; }
            if (hit) { for (uint256 j = 0; j < 20; j++) canonical[i + j] = xl[j]; replaced++; }
        }
        assertEq(replaced, 1, "one self-address immutable");
        assertEq(keccak256(canonical), keccak256(live), "identical after substituting the self-address");
    }

    function test_dynamicFeeFlags() public pure {
        assertEq(LPFeeLibrary.DYNAMIC_FEE_FLAG, 0x800000);
        assertEq(LPFeeLibrary.OVERRIDE_FEE_FLAG, 0x400000);
    }

    /// Uniswap's protocol fee on the deployed PoolManager: pips (1e-6), packed per direction (low 12 bits zeroForOne,
    /// high 12 bits oneForZero), cap 1000 pips = 0.1% each, taken from the swap's INPUT before the LP fee.
    function test_protocolFeeModelOnDeployedPoolManager() public {
        IPoolManager pm = IPoolManager(POOL_MANAGER);
        vm.prank(IOwned(POOL_MANAGER).owner());
        IProtocolFees(POOL_MANAGER).setProtocolFeeController(address(this));

        MockERC20 a = new MockERC20("A", "A", 18);
        MockERC20 b = new MockERC20("B", "B", 18);
        (MockERC20 t0, MockERC20 t1) = address(a) < address(b) ? (a, b) : (b, a);
        PoolSwapTest sw = new PoolSwapTest(pm);
        PoolModifyLiquidityTest lq = new PoolModifyLiquidityTest(pm);
        t0.mint(address(this), 1e30); t1.mint(address(this), 1e30);
        t0.approve(address(sw), type(uint256).max); t1.approve(address(sw), type(uint256).max);
        t0.approve(address(lq), type(uint256).max); t1.approve(address(lq), type(uint256).max);
        PoolKey memory key = PoolKey(Currency.wrap(address(t0)), Currency.wrap(address(t1)), 3000, 60, IHooks(address(0)));
        pm.initialize(key, TickMath.getSqrtPriceAtTick(0));
        lq.modifyLiquidity(key, ModifyLiquidityParams(-6000, 6000, 1e24, 0), "");

        // Cap: 1001 pips in either direction is rejected by the deployed code.
        vm.expectRevert(abi.encodeWithSelector(IProtocolFees.ProtocolFeeTooLarge.selector, uint24(1001)));
        IProtocolFees(POOL_MANAGER).setProtocolFee(key, 1001);
        vm.expectRevert(abi.encodeWithSelector(IProtocolFees.ProtocolFeeTooLarge.selector, uint24(1001) << 12));
        IProtocolFees(POOL_MANAGER).setProtocolFee(key, uint24(1001) << 12);

        // Per direction: 1000 pips (0.1%) on zeroForOne, 0 on oneForZero.
        IProtocolFees(POOL_MANAGER).setProtocolFee(key, 1000);
        uint256 before0 = IProtocolFees(POOL_MANAGER).protocolFeesAccrued(key.currency0);
        sw.swap(key, SwapParams(true, -1_000e18, TickMath.MIN_SQRT_PRICE + 1), PoolSwapTest.TestSettings(false, false), "");
        uint256 accrued0 = IProtocolFees(POOL_MANAGER).protocolFeesAccrued(key.currency0) - before0;
        emit log_named_uint("protocol fee accrued on a 1,000-token zeroForOne swap (wei of input token)", accrued0);
        assertApproxEqAbs(accrued0, 1e18, 2, "1000 pips of a 1,000-token input = 1 token");

        uint256 before1 = IProtocolFees(POOL_MANAGER).protocolFeesAccrued(key.currency1);
        sw.swap(key, SwapParams(false, -1_000e18, TickMath.MAX_SQRT_PRICE - 1), PoolSwapTest.TestSettings(false, false), "");
        assertEq(IProtocolFees(POOL_MANAGER).protocolFeesAccrued(key.currency1), before1, "0 pips on oneForZero: nothing accrued");
    }
}
