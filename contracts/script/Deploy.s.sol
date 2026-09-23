// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {LatchFeed} from "../src/LatchFeed.sol";
import {LatchGate} from "../src/LatchGate.sol";
import {LatchLock} from "../src/LatchLock.sol";
import {LatchEvaluator} from "../src/LatchEvaluator.sol";
import {ILatchFeed, ILatchGate, ILatchLock, ICircuitRegistryView} from "../src/interfaces/ILatch.sol";
import {ICPU} from "../src/vendor/tapeout/interfaces/ICPU.sol";

interface ITapeOutFactory {
    function createCPU(string calldata, string calldata, string calldata, uint256, uint256)
        external
        payable
        returns (address transistors, address circuits);
    function deployFee() external view returns (uint256);
}

interface ITransistors {
    function mint(uint256 id, uint256 amount) external payable;
    function protocolFee() external view returns (uint256);
    function mintPrice() external view returns (uint256);
}

interface ICircuitsTapeout {
    function tapeout(bytes calldata nl, uint32 nIn, uint32 nOut) external payable returns (uint256);
    function TAPEOUT_FEE() external view returns (uint256);
}

/// @notice Deploys the Latch stack; optionally creates a TapeOut processor and tapes out + registers the starters.
///         Writes deployments/<chainId>.json.
///
///         MAINNET REQUIRES AN EXPLICIT "GO" FROM THE PROJECT OWNER. Parameters are read from env, nothing is defaulted
///         for the processor economics on chain 196.
///
///   anvil --fork-url https://rpc.xlayer.tech
///   OWNER=.. TREASURY=.. ATTESTOR=.. CREATE_PROCESSOR=true PROCESSOR_SUPPLY=.. PROCESSOR_PRICE=.. \
///     forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --private-key $KEY --broadcast
contract Deploy is Script {
    address internal constant FACTORY = 0x1f09DAeFA827f02CBb40967cc91b259763760761;

    function run() external {
        address owner = vm.envAddress("OWNER");
        address treasury = vm.envAddress("TREASURY");
        address attestor = vm.envOr("ATTESTOR", address(0));
        uint16 feeBps = uint16(vm.envOr("FEE_BPS", uint256(50)));
        uint16 minLockBps = uint16(vm.envOr("MIN_LOCK_BPS", uint256(500)));
        uint64 maxAge = uint64(vm.envOr("MAX_AGE", uint256(30 minutes)));
        uint32 maxGates = uint32(vm.envOr("MAX_GATES", uint256(512)));
        uint256 evalGasCap = vm.envOr("EVAL_GAS_CAP", uint256(1_500_000));
        bool createProcessor = vm.envOr("CREATE_PROCESSOR", false);
        if (block.chainid == 196) require(vm.envOr("MAINNET_GO", false), "mainnet deploy needs MAINNET_GO=true");

        vm.startBroadcast();
        address deployer = msg.sender;

        LatchEvaluator evaluator = new LatchEvaluator();
        LatchFeed feed = new LatchFeed(deployer, maxAge);
        address predictedGate = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 1);
        LatchLock lock = new LatchLock(ILatchGate(predictedGate), evaluator, treasury, feeBps, minLockBps);
        LatchGate gate = new LatchGate(
            ILatchFeed(address(feed)), ICircuitRegistryView(FACTORY), ILatchLock(address(lock)), evaluator, maxGates, evalGasCap
        );
        require(address(gate) == predictedGate, "gate address prediction");

        string memory out = "deploy";
        vm.serializeAddress(out, "evaluator", address(evaluator));
        vm.serializeAddress(out, "feed", address(feed));
        vm.serializeAddress(out, "gate", address(gate));
        vm.serializeAddress(out, "lock", address(lock));
        vm.serializeUint(out, "block", block.number);

        if (createProcessor) {
            (address transistors, address circuits) = _processor();
            vm.serializeAddress(out, "processor", circuits);
            vm.serializeAddress(out, "transistors", transistors);
            string memory filters = _starters(transistors, circuits, gate);
            vm.serializeString(out, "filters", filters);
        }

        if (attestor != address(0)) feed.setAttestor(attestor, true);
        if (owner != deployer) feed.transferOwnership(owner); // Ownable2Step: owner must acceptOwnership()
        vm.stopBroadcast();

        string memory json = vm.serializeAddress(out, "deployer", deployer);
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), ".json"));
        console2.log("evaluator", address(evaluator));
        console2.log("feed", address(feed));
        console2.log("gate", address(gate));
        console2.log("lock", address(lock));
    }

    function _processor() internal returns (address transistors, address circuits) {
        ITapeOutFactory f = ITapeOutFactory(FACTORY);
        (transistors, circuits) = f.createCPU{value: f.deployFee()}(
            vm.envString("PROCESSOR_NAME"),
            vm.envString("PROCESSOR_SYMBOL"),
            vm.envString("PROCESSOR_STORY"),
            vm.envUint("PROCESSOR_SUPPLY"),
            vm.envUint("PROCESSOR_PRICE")
        );
    }

    function _starters(address transistors, address circuits, LatchGate gate) internal returns (string memory filters) {
        string memory json = vm.readFile("test/fixtures/circuits.json");
        uint256 n = vm.parseJsonUint(json, ".count");
        ITransistors t = ITransistors(transistors);
        ICircuitsTapeout c = ICircuitsTapeout(circuits);
        filters = "filters";
        string memory last;
        for (uint256 i = 0; i < n; i++) {
            string memory p = string.concat(".circuits[", vm.toString(i), "]");
            string memory name = vm.parseJsonString(json, string.concat(p, ".name"));
            uint256 nand = vm.parseJsonUint(json, string.concat(p, ".nandCount"));
            uint256 latch = vm.parseJsonUint(json, string.concat(p, ".latchCount"));
            if (nand > 0) t.mint{value: t.mintPrice() * nand + t.protocolFee()}(0, nand);
            if (latch > 0) t.mint{value: t.mintPrice() * latch + t.protocolFee()}(1, latch);
            uint256 cid = c.tapeout{value: c.TAPEOUT_FEE()}(vm.parseJsonBytes(json, string.concat(p, ".netlist")), 16, 1);
            uint256 fid = gate.registerFilter(
                ICPU(circuits), cid, name, vm.parseJsonBytes32(json, string.concat(p, ".netlistHash"))
            );
            last = vm.serializeUint(filters, name, fid);
        }
        return last;
    }
}
