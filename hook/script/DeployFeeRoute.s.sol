// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Deploys FeeRouteHook with the confirmed final configuration: tape out the four circuits on the existing Nandout
// processor (one mint of 16 NAND transistors, four tape-outs), mine the hook address locally, deploy through the
// canonical CREATE2 deployer, and write hook/deployments/<chainid>.json. Run through script/deploy.sh, which refuses any
// non-local RPC unless HOOK_MAINNET_GO=yes.
import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {ICPU} from "latch/vendor/tapeout/interfaces/ICPU.sol";
import {ICircuitRegistryView, ILatchEvaluator} from "latch/interfaces/ILatch.sol";
import {FeeCircuitHook} from "../src/FeeCircuitHook.sol";
import {FeeRouteHook} from "../src/FeeRouteHook.sol";

interface ITransistorsD {
    function mint(uint256 id, uint256 amount) external payable;
    function mintPrice() external view returns (uint256);
    function protocolFee() external view returns (uint256);
}

interface ICircuitsD {
    function tapeout(bytes calldata nl, uint32 nIn, uint32 nOut) external payable returns (uint256);
    function TAPEOUT_FEE() external view returns (uint256);
    function transistors() external view returns (address);
}

contract DeployFeeRoute is Script {
    IPoolManager constant PM = IPoolManager(0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32);
    ILatchEvaluator constant EVALUATOR = ILatchEvaluator(0x8cA3ecB418962801e64FF1e847a444fAB6352D03);
    ICircuitRegistryView constant TAPEOUT = ICircuitRegistryView(0x1f09DAeFA827f02CBb40967cc91b259763760761);
    address constant PROCESSOR = 0x8A60B4A4BCf4066F5E5F9A406fE09c5e4f52a58E;
    address constant CREATE2 = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address constant RECIPIENT = 0x934d315C0a9C0866D393B722C1805F2B6b20b816; // Nandout deploy wallet (hook fee)
    uint160 constant FLAGS = (1 << 7) | (1 << 6) | (1 << 2); // beforeSwap, afterSwap, afterSwapReturnsDelta

    function run() external {
        require(block.chainid == 196, "X Layer only");
        string memory fee = vm.readFile("test/fixtures/fee-circuits.json");
        string memory rte = vm.readFile("test/fixtures/route-circuits.json");
        ICircuitsD cpu = ICircuitsD(PROCESSOR);
        ITransistorsD tr = ITransistorsD(cpu.transistors());
        uint256 nand = _n(fee, 0) + _n(fee, 1) + _n(rte, 0) + _n(rte, 1);
        require(nand == 16, "expected 16 transistors");

        vm.startBroadcast();
        tr.mint{value: tr.mintPrice() * nand + tr.protocolFee()}(0, nand);
        FeeCircuitHook.Guard memory vol = _tapeout(cpu, fee, 0);
        FeeCircuitHook.Guard memory depth = _tapeout(cpu, fee, 1);
        FeeCircuitHook.Guard memory split = _tapeout(cpu, rte, 0);
        FeeCircuitHook.Guard memory guard = _tapeout(cpu, rte, 1);

        uint24[4] memory fees = [uint24(500), 3000, 6000, 10000]; // 0.05 / 0.30 / 0.60 / 1.00 %
        FeeCircuitHook.Thresholds memory t = FeeCircuitHook.Thresholds(20_000, 5_000, 5_000, 2_500);
        FeeRouteHook.RouteConfig memory r = FeeRouteHook.RouteConfig(
            split, guard, [address(0), address(0), address(0), address(0)], 5, Currency.wrap(address(0)), 1000, RECIPIENT
        );
        bytes memory init = abi.encodePacked(type(FeeRouteHook).creationCode, abi.encode(PM, EVALUATOR, TAPEOUT, vol, depth, fees, t, uint32(60), r));
        (bytes32 salt, address hook) = _mine(init);
        (bool ok,) = CREATE2.call(abi.encodePacked(salt, init));
        require(ok && hook.code.length > 0, "hook deploy");
        vm.stopBroadcast();

        string memory o = "d";
        vm.serializeAddress(o, "hook", hook);
        vm.serializeBytes32(o, "salt", salt);
        vm.serializeUint(o, "VOL_GUARD", vol.circuitId);
        vm.serializeUint(o, "DEPTH_GUARD", depth.circuitId);
        vm.serializeUint(o, "ROUTE_SPLIT", split.circuitId);
        vm.serializeUint(o, "ROUTE_GUARD", guard.circuitId);
        vm.serializeAddress(o, "processor", PROCESSOR);
        vm.serializeAddress(o, "hookFeeRecipient", RECIPIENT);
        string memory json = vm.serializeBytes(o, "constructorArgs", _args(init));
        vm.writeJson(json, string.concat("deployments/", vm.envOr("DEPLOY_OUT", string("196-dryrun")), ".json"));
        console2.log("hook", hook);
    }

    function _n(string memory json, uint256 i) internal pure returns (uint256) {
        return vm.parseJsonUint(json, string.concat(".circuits[", vm.toString(i), "].nandCount"));
    }

    function _tapeout(ICircuitsD cpu, string memory json, uint256 i) internal returns (FeeCircuitHook.Guard memory) {
        string memory p = string.concat(".circuits[", vm.toString(i), "]");
        uint256 id = cpu.tapeout{value: cpu.TAPEOUT_FEE()}(vm.parseJsonBytes(json, string.concat(p, ".netlist")), 16, 1);
        return FeeCircuitHook.Guard(ICPU(PROCESSOR), id, vm.parseJsonBytes32(json, string.concat(p, ".netlistHash")));
    }

    function _mine(bytes memory init) internal pure returns (bytes32 salt, address addr) {
        bytes32 h = keccak256(init);
        for (uint256 i = 0;; i++) {
            addr = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2, bytes32(i), h)))));
            if (uint160(addr) & ((1 << 14) - 1) == FLAGS) return (bytes32(i), addr);
        }
    }

    function _args(bytes memory init) internal pure returns (bytes memory a) {
        uint256 n = type(FeeRouteHook).creationCode.length;
        a = new bytes(init.length - n);
        for (uint256 i = 0; i < a.length; i++) a[i] = init[n + i];
    }
}
