// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Phase 0 gas benchmark. LOCAL FORK ONLY: run with --fork-url pointing at a local anvil fork of X Layer.
import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {SSTORE2} from "latch/vendor/tapeout/lib/SSTORE2.sol";
import {FeeEvaluator} from "../src/FeeEvaluator.sol";
import {BenchHook, FactFeed, IFactFeed} from "../src/bench/BenchHook.sol";

contract NetlistStore { function put(bytes calldata nl) external returns (address) { return SSTORE2.write(nl); } }

contract Bench is Script {
    IPoolManager constant PM = IPoolManager(0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32);
    address constant CREATE2 = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint160 constant BEFORE_SWAP = 1 << 7;
    uint160 constant ALL_FLAGS = (1 << 14) - 1;

    MockERC20 t0; MockERC20 t1;
    PoolSwapTest swapR; PoolModifyLiquidityTest liqR;

    /// Pseudo-random but valid NAND netlist: 7 inputs, `g` gates, last 2 gates are the tier outputs.
    function netlist(uint256 g) internal pure returns (bytes memory nl) {
        uint256 sigs = 2 + 7;
        for (uint256 i = 0; i < g; i++) {
            uint256 r = uint256(keccak256(abi.encode(g, i)));
            uint256 a = 2 + (r % (sigs - 2)); uint256 b = 2 + ((r >> 32) % (sigs - 2));
            nl = bytes.concat(nl, bytes1(0x00), bytes3(uint24(a)), bytes3(uint24(b)));
            sigs++;
        }
    }

    function mine(bytes memory initCode) internal view returns (bytes32 salt, address addr, uint256 tries) {
        bytes32 h = keccak256(initCode);
        for (uint256 i = 0; ; i++) {
            addr = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2, bytes32(i), h)))));
            if (uint160(addr) & ALL_FLAGS == BEFORE_SWAP) return (bytes32(i), addr, i + 1);
        }
    }

    function hook(uint8 mode, FeeEvaluator e, address nl, uint256 table, IFactFeed f) internal returns (address) {
        bytes memory init = abi.encodePacked(type(BenchHook).creationCode, abi.encode(PM, mode, e, nl, table, f));
        (bytes32 salt, address addr, uint256 tries) = mine(init);
        (bool ok,) = CREATE2.call(abi.encodePacked(salt, init));
        require(ok && addr.code.length > 0, "create2");
        console2.log("mined hook mode", mode, "tries", tries);
        return addr;
    }

    function pool(address h, uint24 fee) internal returns (PoolKey memory key) {
        key = PoolKey(Currency.wrap(address(t0)), Currency.wrap(address(t1)), fee, 60, IHooks(h));
        PM.initialize(key, TickMath.getSqrtPriceAtTick(0));
        liqR.modifyLiquidity(key, ModifyLiquidityParams(-6000, 6000, 1e24, 0), "");
    }

    function swaps(string memory label, PoolKey memory key) internal {
        for (uint256 i = 0; i < 4; i++) {
            bool z = i % 2 == 0;
            swapR.swap(key, SwapParams(z, -1e20, z ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1), PoolSwapTest.TestSettings(false, false), "");
            console2.log("SWAP", label, i);
        }
    }

    function run() external {
        vm.startBroadcast();
        MockERC20 a = new MockERC20("A", "A", 18); MockERC20 b = new MockERC20("B", "B", 18);
        (t0, t1) = address(a) < address(b) ? (a, b) : (b, a);
        t0.mint(msg.sender, 1e30); t1.mint(msg.sender, 1e30);
        swapR = new PoolSwapTest(PM); liqR = new PoolModifyLiquidityTest(PM);
        t0.approve(address(swapR), type(uint256).max); t1.approve(address(swapR), type(uint256).max);
        t0.approve(address(liqR), type(uint256).max); t1.approve(address(liqR), type(uint256).max);
        FactFeed feed = new FactFeed();
        FeeEvaluator ev = new FeeEvaluator();
        NetlistStore store = new NetlistStore();
        address nl8 = store.put(netlist(8)); address nl16 = store.put(netlist(16)); address nl32 = store.put(netlist(32));
        uint256 table16 = ev.computeTable(nl16);

        swaps("plain_nohook_0.30", pool(address(0), 3000));
        swaps("m0_fixed_override", pool(hook(0, ev, nl16, table16, feed), LPFeeLibrary.DYNAMIC_FEE_FLAG));
        swaps("m1_live_eval_8g", pool(hook(1, ev, nl8, 0, feed), LPFeeLibrary.DYNAMIC_FEE_FLAG));
        swaps("m1_live_eval_16g", pool(hook(1, ev, nl16, 0, feed), LPFeeLibrary.DYNAMIC_FEE_FLAG));
        swaps("m1_live_eval_32g", pool(hook(1, ev, nl32, 0, feed), LPFeeLibrary.DYNAMIC_FEE_FLAG));
        swaps("m2_table_16g", pool(hook(2, ev, nl16, table16, feed), LPFeeLibrary.DYNAMIC_FEE_FLAG));
        swaps("m3_live16_plus_vol", pool(hook(3, ev, nl16, 0, feed), LPFeeLibrary.DYNAMIC_FEE_FLAG));
        swaps("m4_table16_plus_vol", pool(hook(4, ev, nl16, table16, feed), LPFeeLibrary.DYNAMIC_FEE_FLAG));
        vm.stopBroadcast();
    }
}
