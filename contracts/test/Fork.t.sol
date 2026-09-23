// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LatchFeed} from "../src/LatchFeed.sol";
import {LatchGate} from "../src/LatchGate.sol";
import {LatchLock} from "../src/LatchLock.sol";
import {LatchEvaluator} from "../src/LatchEvaluator.sol";
import {LatchBits} from "../src/LatchBits.sol";
import {ILatchFeed, ILatchGate, ILatchLock, ICircuitRegistryView} from "../src/interfaces/ILatch.sol";
import {ICPU} from "../src/vendor/tapeout/interfaces/ICPU.sol";

interface ITapeOutFactory {
    function createCPU(string calldata, string calldata, string calldata, uint256, uint256)
        external
        payable
        returns (address transistors, address circuits);
    function deployFee() external view returns (uint256);
    function isSealed() external view returns (bool);
}

interface ITransistors {
    function mint(uint256 id, uint256 amount) external payable;
    function protocolFee() external view returns (uint256);
    function mintPrice() external view returns (uint256);
    function withdraw() external;
    function owed(address) external view returns (uint256);
}

interface ICircuitsTapeout {
    function tapeout(bytes calldata nl, uint32 nIn, uint32 nOut) external payable returns (uint256);
    function TAPEOUT_FEE() external view returns (uint256);
}

/// @notice Full flow against the real TapeOut contracts on an X Layer mainnet fork (local only, nothing is broadcast).
///         Skipped unless XLAYER_RPC_URL is set:  XLAYER_RPC_URL=https://rpc.xlayer.tech forge test --mc ForkTest
contract ForkTest is Test {
    ITapeOutFactory internal constant FACTORY = ITapeOutFactory(0x1f09DAeFA827f02CBb40967cc91b259763760761);

    address internal deployer = makeAddr("deployer");
    address internal attestor = makeAddr("attestor");
    address internal token = makeAddr("launch");

    function setUp() public {
        string memory rpc = vm.envOr("XLAYER_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);
        vm.deal(deployer, 10 ether);
    }

    function test_fork_fullFlow() public {
        emit log_named_string("factory sealed", FACTORY.isSealed() ? "yes" : "no");

        // 1. processor through the real factory
        vm.startPrank(deployer);
        (address transistors, address circuits) =
            FACTORY.createCPU{value: FACTORY.deployFee()}("Latch", "LATCH", "fork test", 10_000, 0.0001 ether);

        // 2. mint + tape out every starter circuit
        string memory json = vm.readFile("test/fixtures/circuits.json");
        uint256 n = 6;
        uint256[] memory cids = new uint256[](n);
        bytes32[] memory hashes = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            string memory p = string.concat(".circuits[", vm.toString(i), "]");
            bytes memory nl = vm.parseJsonBytes(json, string.concat(p, ".netlist"));
            hashes[i] = vm.parseJsonBytes32(json, string.concat(p, ".netlistHash"));
            uint256 nand = vm.parseJsonUint(json, string.concat(p, ".nandCount"));
            uint256 latch = vm.parseJsonUint(json, string.concat(p, ".latchCount"));
            _mint(transistors, 0, nand);
            _mint(transistors, 1, latch);
            cids[i] = ICircuitsTapeout(circuits).tapeout{value: ICircuitsTapeout(circuits).TAPEOUT_FEE()}(nl, 16, 1);
            (uint32 nIn, uint32 nOut, uint32 nState, uint32 gates) = ICPU(circuits).circuitInfo(cids[i]);
            assertEq(nIn, 16);
            assertEq(nOut, 1);
            assertEq(nState, latch);
            assertEq(gates, nand + latch);
            assertEq(keccak256(ICPU(circuits).netlist(cids[i])), hashes[i], "netlist round-trips byte-identical");
        }
        // mint proceeds accrue to the processor creator (Revenue 1)
        assertGt(ITransistors(transistors).owed(deployer), 0);
        vm.stopPrank();

        // 3. Latch stack with the real factory as registry
        LatchFeed feed = new LatchFeed(deployer, 30 minutes);
        vm.prank(deployer);
        feed.setAttestor(attestor, true);
        LatchEvaluator evaluator = new LatchEvaluator();
        address predictedGate = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        LatchLock lock = new LatchLock(ILatchGate(predictedGate), evaluator, deployer, 50, 500);
        LatchGate gate = new LatchGate(
            ILatchFeed(address(feed)), ICircuitRegistryView(address(FACTORY)), ILatchLock(address(lock)), evaluator, 512, 1_500_000
        );
        uint256[] memory fids = new uint256[](n);
        for (uint256 i = 0; i < n; i++) fids[i] = gate.registerFilter(ICPU(circuits), cids[i], "starter", hashes[i]);

        // 4. live TapeOut eval and local snapshot agree on a spread of inputs
        uint16[5] memory samples = [
            uint16(0),
            LatchBits.ATTESTED_MASK,
            LatchBits.LP_LOCKED | LatchBits.TOP10_LT_40 | LatchBits.DEV_NO_SELL_7D,
            LatchBits.AGENT_LINKED | LatchBits.REV_GT_0 | LatchBits.LP_LOCKED | LatchBits.HOLDERS_GE_100,
            LatchBits.TOP10_LT_40 | LatchBits.DEV_NO_SELL_7D | LatchBits.HOLDERS_GE_100 | LatchBits.LP_PULLED
        ];
        for (uint256 s = 0; s < samples.length; s++) {
            LatchFeed.Update[] memory u = new LatchFeed.Update[](1);
            u[0] = LatchFeed.Update(token, samples[s], uint64(block.timestamp - 40 days), deployer);
            vm.prank(attestor);
            feed.post(u);
            for (uint256 i = 0; i < n; i++) {
                (bool live, bool local,) = gate.verify(token, fids[i]);
                assertEq(live, local);
            }
        }
        uint256 g0 = gasleft();
        gate.check(token, fids[2]);
        emit log_named_uint("STRICT check gas on real TapeOut", g0 - gasleft());
    }

    function _mint(address transistors, uint256 id, uint256 amount) internal {
        if (amount == 0) return;
        ITransistors t = ITransistors(transistors);
        t.mint{value: t.mintPrice() * amount + t.protocolFee()}(id, amount);
    }
}
