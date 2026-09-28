// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {FeeRouteHook} from "../src/FeeRouteHook.sol";

interface IPosmE { function modifyLiquidities(bytes calldata, uint256) external payable; }
interface IERC20E { function approve(address, uint256) external returns (bool); function balanceOf(address) external view returns (uint256); }

/// Tier evidence for Nandout's demo pool WITHOUT any mainnet trade: a local fork of X Layer at the latest block, i.e. the
/// live pool exactly as deployed (hook 0xfd77…80c4, pool 0x806b…2671, liquidity from the deploy wallet). Swaps here are
/// on the fork only and are discarded. Opt-in: XCAT_EVIDENCE=true.
contract XcatPoolEvidenceForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager constant PM = IPoolManager(0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32);
    FeeRouteHook constant HOOK = FeeRouteHook(0xfd77af872A8f590680Fd27D79319e2e4E08E80c4);
    IERC20E constant XCAT = IERC20E(0xbB9A906f1A8906D548C5D94b7079fA31bF09EEee);
    IPosmE constant POSM = IPosmE(0xcF1EAFC6928dC385A342E7C6491d371d2871458b);
    address constant OWNER = 0x934d315C0a9C0866D393B722C1805F2B6b20b816;
    uint256 constant TOKEN_ID = 12817;
    bytes32 constant SWAP_EVENT = keccak256("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");
    address trader = makeAddr("forkOnlyTrader");
    PoolSwapTest router;
    PoolKey key;

    function setUp() public {
        string memory rpc = vm.envOr("XLAYER_RPC_URL", string(""));
        if (bytes(rpc).length == 0 || !vm.envOr("XCAT_EVIDENCE", false)) vm.skip(true);
        vm.createSelectFork(rpc);
        key = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(XCAT)), LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(address(HOOK)));
        router = new PoolSwapTest(PM);
        vm.deal(trader, 10 ether);
        vm.prank(trader);
        XCAT.approve(address(router), type(uint256).max);
    }

    function test_tierEvidence() public {
        emit log_named_uint("fork of X Layer mainnet at block", block.number);
        uint128 liq = PM.getLiquidity(key.toId());
        emit log_named_uint("live pool in-range liquidity", liq);
        assertGt(liq, 0, "the live pool has the deploy wallet's liquidity");

        uint24 f;
        f = _buy(0.001 ether); // first observation
        emit log_named_uint("1. calm (first swap) -> LP fee pips", f);
        vm.roll((vm.getBlockNumber() / 60 + 1) * 60);
        f = _buy(0.001 ether); // baseline seeded
        emit log_named_uint("2. calm, baseline seeded -> LP fee pips", f);

        // Push the price ~800+ ticks in the last block of an epoch, unwind in the first block of the next (sampled).
        vm.roll((vm.getBlockNumber() / 60 + 1) * 60 - 1);
        (, int24 t0,,) = PM.getSlot0(key.toId());
        _toTick(t0 - 900);
        vm.roll(vm.getBlockNumber() + 1);
        f = _toTick(t0);
        emit log_named_uint("3. volatile (displacement held across an epoch boundary) -> LP fee pips", f);
        f = _buy(0.001 ether);
        emit log_named_uint("4. volatile, next swap -> LP fee pips", f);

        // The LP (deploy wallet) pulls 80% on the fork: depth falls below 50% of the pool's own baseline -> thin.
        bytes memory actions = abi.encodePacked(uint8(0x01), uint8(0x11)); // DECREASE_LIQUIDITY, TAKE_PAIR
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(TOKEN_ID, uint256(liq) * 8 / 10, uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1, OWNER);
        vm.prank(OWNER);
        POSM.modifyLiquidities(abi.encode(actions, params), block.timestamp + 600);
        f = _buy(0.0005 ether);
        emit log_named_uint("5. volatile + thin -> LP fee pips", f);
        emit log_named_uint("   fact bits now (0 VOL_HIGH,1 VOL_ELEVATED,2 DEPTH_THIN,3 DEPTH_CRITICAL,4 DEPTH_DRAIN)", HOOK.currentFacts(key));
    }

    function _buy(uint256 okb) internal returns (uint24) {
        return _swap(true, -int256(okb), TickMath.MIN_SQRT_PRICE + 1, okb);
    }

    function _toTick(int24 target) internal returns (uint24) {
        (, int24 tick,,) = PM.getSlot0(key.toId());
        bool z = target < tick;
        // XCAT per OKB is currency1/currency0: buying XCAT (zeroForOne) lowers the tick.
        return _swap(z, z ? -int256(1 ether) : -int256(uint256(1e30)), TickMath.getSqrtPriceAtTick(target), z ? 1 ether : 0);
    }

    function _swap(bool z, int256 amt, uint160 limit, uint256 value) internal returns (uint24 fee) {
        vm.recordLogs();
        vm.prank(trader);
        router.swap{value: value}(key, SwapParams(z, amt, limit), PoolSwapTest.TestSettings(false, false), "");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(PM) && logs[i].topics[0] == SWAP_EVENT) {
                (,,,,, fee) = abi.decode(logs[i].data, (int128, int128, uint160, uint128, int24, uint24));
            }
        }
    }
}
