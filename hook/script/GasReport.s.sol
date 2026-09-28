// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Gas report: plain pool vs FeeCircuitHook (table lookup) vs the same hook evaluating both circuits live every swap.
// LOCAL FORK ONLY. Run through script/gas-report.sh, which refuses any non-local RPC.
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
import {ICPU} from "latch/vendor/tapeout/interfaces/ICPU.sol";
import {ICircuitRegistryView, ILatchEvaluator} from "latch/interfaces/ILatch.sol";
import {FeeCircuitHook} from "../src/FeeCircuitHook.sol";
import {FeeRouteHook} from "../src/FeeRouteHook.sol";

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

/// Benchmark only: identical facts code, but both circuits are evaluated live on every swap.
contract LiveEvalHook is FeeCircuitHook {
    constructor(IPoolManager pm, ILatchEvaluator ev, ICircuitRegistryView reg, Guard memory v, Guard memory d, uint24[4] memory fees, Thresholds memory t, uint32 e)
        FeeCircuitHook(pm, ev, reg, v, d, fees, t, e) {}

    function _tier(uint8 facts) internal view override returns (uint8) {
        (bool v,) = evaluator.evaluate(volNetlist, "", facts);
        (bool d,) = evaluator.evaluate(depthNetlist, "", facts);
        return (v ? 2 : 0) | (d ? 1 : 0);
    }
}

contract GasReport is Script {
    IPoolManager constant PM = IPoolManager(0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32);
    ILatchEvaluator constant EVALUATOR = ILatchEvaluator(0x8cA3ecB418962801e64FF1e847a444fAB6352D03);
    ICircuitRegistryView constant TAPEOUT = ICircuitRegistryView(0x1f09DAeFA827f02CBb40967cc91b259763760761);
    address constant PROCESSOR = 0x8A60B4A4BCf4066F5E5F9A406fE09c5e4f52a58E;
    address constant CREATE2 = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    MockERC20 t0; MockERC20 t1;
    PoolSwapTest swapR; PoolModifyLiquidityTest liqR;

    function run() external {
        require(block.chainid == 196, "X Layer fork only");
        string memory json = vm.readFile("test/fixtures/fee-circuits.json");
        string memory rjson = vm.readFile("test/fixtures/route-circuits.json");
        vm.startBroadcast();
        FeeCircuitHook.Guard memory v = _tapeout(json, 0);
        FeeCircuitHook.Guard memory d = _tapeout(json, 1);
        FeeCircuitHook.Guard memory rs = _tapeout(rjson, 0);
        FeeCircuitHook.Guard memory rg = _tapeout(rjson, 1);
        MockERC20 a = new MockERC20("A", "A", 18); MockERC20 b = new MockERC20("B", "B", 18);
        (t0, t1) = address(a) < address(b) ? (a, b) : (b, a);
        t0.mint(msg.sender, 1e40); t1.mint(msg.sender, 1e40);
        swapR = new PoolSwapTest(PM); liqR = new PoolModifyLiquidityTest(PM);
        t0.approve(address(swapR), type(uint256).max); t1.approve(address(swapR), type(uint256).max);
        t0.approve(address(liqR), type(uint256).max); t1.approve(address(liqR), type(uint256).max);

        uint24[4] memory fees = [uint24(500), 3000, 6000, 10000];
        FeeCircuitHook.Thresholds memory t = FeeCircuitHook.Thresholds(20_000, 5_000, 1e22, 1e21);
        bytes memory args = abi.encode(PM, EVALUATOR, TAPEOUT, v, d, fees, t, uint32(60));
        address table = _deploy(abi.encodePacked(type(FeeCircuitHook).creationCode, args), 1 << 7);
        address live = _deploy(abi.encodePacked(type(LiveEvalHook).creationCode, args), 1 << 7);
        FeeRouteHook.RouteConfig memory r = FeeRouteHook.RouteConfig(
            rs, rg, [address(uint160(uint256(keccak256("reserve")))), address(uint160(uint256(keccak256("holders")))), address(0), address(0)],
            100, Currency.wrap(address(t1))
        );
        address route = _deploy(abi.encodePacked(type(FeeRouteHook).creationCode, abi.encode(PM, EVALUATOR, TAPEOUT, v, d, fees, t, uint32(60), r)), (1 << 7) | (1 << 6) | (1 << 2));

        _swaps("plain_static_0.30", _pool(address(0), 3000));
        _swaps("hook_tier_table", _pool(table, LPFeeLibrary.DYNAMIC_FEE_FLAG));
        _swaps("hook_tier_live_eval", _pool(live, LPFeeLibrary.DYNAMIC_FEE_FLAG));
        _swaps("hook_tier_plus_route", _pool(route, LPFeeLibrary.DYNAMIC_FEE_FLAG));
        vm.stopBroadcast();
    }

    function _tapeout(string memory json, uint256 i) internal returns (FeeCircuitHook.Guard memory) {
        string memory p = string.concat(".circuits[", vm.toString(i), "]");
        bytes memory nl = vm.parseJsonBytes(json, string.concat(p, ".netlist"));
        uint256 nand = vm.parseJsonUint(json, string.concat(p, ".nandCount"));
        ITransistors tr = ITransistors(ICircuitsTapeout(PROCESSOR).transistors());
        tr.mint{value: tr.mintPrice() * nand + tr.protocolFee()}(0, nand);
        uint256 id = ICircuitsTapeout(PROCESSOR).tapeout{value: ICircuitsTapeout(PROCESSOR).TAPEOUT_FEE()}(nl, 16, 1);
        return FeeCircuitHook.Guard(ICPU(PROCESSOR), id, vm.parseJsonBytes32(json, string.concat(p, ".netlistHash")));
    }

    function _deploy(bytes memory init, uint160 flags) internal returns (address addr) {
        bytes32 h = keccak256(init);
        uint256 salt;
        for (;; salt++) {
            addr = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2, bytes32(salt), h)))));
            if (uint160(addr) & ((1 << 14) - 1) == flags) break;
        }
        (bool ok,) = CREATE2.call(abi.encodePacked(bytes32(salt), init));
        require(ok && addr.code.length > 0, "create2");
        console2.log("DEPLOY", addr, "salt tries", salt + 1);
    }

    function _pool(address hook, uint24 fee) internal returns (PoolKey memory key) {
        key = PoolKey(Currency.wrap(address(t0)), Currency.wrap(address(t1)), fee, 60, IHooks(hook));
        PM.initialize(key, TickMath.getSqrtPriceAtTick(0));
        liqR.modifyLiquidity(key, ModifyLiquidityParams(-6000, 6000, 1e23, 0), "");
    }

    function _swaps(string memory label, PoolKey memory key) internal {
        for (uint256 i = 0; i < 6; i++) {
            bool z = i % 2 == 0;
            swapR.swap(key, SwapParams(z, -1e20, z ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1), PoolSwapTest.TestSettings(false, false), "");
            console2.log("SWAP", label, i);
        }
    }
}
