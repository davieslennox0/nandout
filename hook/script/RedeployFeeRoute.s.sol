// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Redeploys FeeRouteHook with the hook fee taken in afterSwap on the ACTUAL filled unspecified amount (FeeTakingHook
// model), replacing the deprecated 0x9553B82Baf7EB83e155b33F003d89Aa1D1b040cc (which charged exact-input fees on the
// SPECIFIED amount and overcharged partial fills). Reuses the circuits already taped out on the Nandout processor
// (#7-#10); no new tape-outs. Run through script/redeploy.sh (dry-run on a fork unless HOOK_MAINNET_GO=yes).
import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {ICPU} from "latch/vendor/tapeout/interfaces/ICPU.sol";
import {ICircuitRegistryView, ILatchEvaluator} from "latch/interfaces/ILatch.sol";
import {FeeCircuitHook} from "../src/FeeCircuitHook.sol";
import {FeeRouteHook} from "../src/FeeRouteHook.sol";

contract RedeployFeeRoute is Script {
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
        FeeCircuitHook.Guard memory vol = FeeCircuitHook.Guard(ICPU(PROCESSOR), 7, vm.parseJsonBytes32(fee, ".circuits[0].netlistHash"));
        FeeCircuitHook.Guard memory depth = FeeCircuitHook.Guard(ICPU(PROCESSOR), 8, vm.parseJsonBytes32(fee, ".circuits[1].netlistHash"));
        FeeCircuitHook.Guard memory split = FeeCircuitHook.Guard(ICPU(PROCESSOR), 9, vm.parseJsonBytes32(rte, ".circuits[0].netlistHash"));
        FeeCircuitHook.Guard memory guard = FeeCircuitHook.Guard(ICPU(PROCESSOR), 10, vm.parseJsonBytes32(rte, ".circuits[1].netlistHash"));
        FeeRouteHook.RouteConfig memory r = FeeRouteHook.RouteConfig(
            split, guard, [address(0), address(0), address(0), address(0)], 5, Currency.wrap(address(0)), 1000, RECIPIENT
        );
        bytes memory init = abi.encodePacked(
            type(FeeRouteHook).creationCode,
            abi.encode(PM, EVALUATOR, TAPEOUT, vol, depth, [uint24(500), 3000, 6000, 10000], FeeCircuitHook.Thresholds(20_000, 5_000, 5_000, 2_500), uint32(60), r)
        );
        bytes32 h = keccak256(init);
        uint256 salt;
        address hook;
        for (;; salt++) {
            hook = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2, bytes32(salt), h)))));
            if (uint160(hook) & ((1 << 14) - 1) == FLAGS) break;
        }
        vm.startBroadcast();
        (bool ok,) = CREATE2.call(abi.encodePacked(bytes32(salt), init));
        vm.stopBroadcast();
        require(ok && hook.code.length > 0, "hook deploy");
        uint256 n = type(FeeRouteHook).creationCode.length;
        bytes memory args = new bytes(init.length - n);
        for (uint256 i = 0; i < args.length; i++) args[i] = init[n + i];
        string memory o = "r";
        vm.serializeAddress(o, "hook", hook);
        vm.serializeBytes32(o, "salt", bytes32(salt));
        vm.serializeAddress(o, "deprecated", 0x9553B82Baf7EB83e155b33F003d89Aa1D1b040cc);
        string memory json = vm.serializeBytes(o, "constructorArgs", args);
        vm.writeJson(json, string.concat("deployments/", vm.envOr("DEPLOY_OUT", string("196-v2-dryrun")), ".json"));
        console2.log("hook", hook);
    }
}
