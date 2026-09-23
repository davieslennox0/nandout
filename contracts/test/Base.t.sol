// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LatchFeed} from "../src/LatchFeed.sol";
import {LatchGate} from "../src/LatchGate.sol";
import {LatchLock} from "../src/LatchLock.sol";
import {LatchBits} from "../src/LatchBits.sol";
import {ILatchFeed, ILatchGate, ILatchLock, ICircuitRegistryView} from "../src/interfaces/ILatch.sol";
import {ICPU} from "../src/vendor/tapeout/interfaces/ICPU.sol";
import {MockTapeOut} from "./mocks/MockTapeOut.sol";

/// @notice Deploys the full stack against MockTapeOut and registers the compiler's starter circuits
///         (test/fixtures/circuits.json, produced by `pnpm compile:circuits`).
abstract contract Base is Test {
    uint64 internal constant MAX_AGE = 30 minutes;
    uint16 internal constant FEE_BPS = 50;
    uint16 internal constant MIN_LOCK_BPS = 500; // 5% of supply
    uint32 internal constant MAX_GATES = 512;
    uint256 internal constant EVAL_GAS_CAP = 1_500_000;

    address internal owner = makeAddr("owner");
    address internal attestor = makeAddr("attestor");
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");
    address internal beneficiary = makeAddr("beneficiary");

    MockTapeOut internal tapeout;
    LatchFeed internal feed;
    LatchGate internal gate;
    LatchLock internal lock;

    mapping(string => uint256) internal filterId;
    string[] internal starterNames;

    function setUp() public virtual {
        vm.warp(1_760_000_000);
        tapeout = new MockTapeOut();
        feed = new LatchFeed(owner, MAX_AGE);
        vm.prank(owner);
        feed.setAttestor(attestor, true);

        address predictedGate = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        lock = new LatchLock(ILatchGate(predictedGate), treasury, FEE_BPS, MIN_LOCK_BPS);
        gate = new LatchGate(
            ILatchFeed(address(feed)), ICircuitRegistryView(address(tapeout)), ILatchLock(address(lock)), MAX_GATES, EVAL_GAS_CAP
        );
        assertEq(address(gate), predictedGate);

        string memory json = vm.readFile("test/fixtures/circuits.json");
        for (uint256 i = 0; i < 6; i++) {
            string memory p = string.concat(".circuits[", vm.toString(i), "]");
            string memory name = vm.parseJsonString(json, string.concat(p, ".name"));
            bytes memory nl = vm.parseJsonBytes(json, string.concat(p, ".netlist"));
            bytes32 h = vm.parseJsonBytes32(json, string.concat(p, ".netlistHash"));
            filterId[name] = _tapeAndRegister(nl, name, h);
            if (vm.parseJsonUint(json, string.concat(p, ".nState")) == 0) starterNames.push(name);
        }
        string memory sj = vm.readFile("test/fixtures/sticky_test.json");
        filterId["STICKY_TEST"] =
            _tapeAndRegister(vm.parseJsonBytes(sj, ".netlist"), "STICKY_TEST", vm.parseJsonBytes32(sj, ".netlistHash"));
    }

    function _tapeAndRegister(bytes memory nl, string memory name, bytes32 h) internal returns (uint256) {
        uint256 cid = tapeout.tapeout(nl, 16, 1);
        return gate.registerFilter(ICPU(address(tapeout)), cid, name, h);
    }

    function _post(address token, uint16 bits, uint64 launchTime, address creator_) internal {
        LatchFeed.Update[] memory u = new LatchFeed.Update[](1);
        u[0] = LatchFeed.Update(token, bits, launchTime, creator_);
        vm.prank(attestor);
        feed.post(u);
    }

    function _post(address token, uint16 bits) internal {
        _post(token, bits, uint64(block.timestamp), creator);
    }

    /// @dev Reference semantics for the starter filters (must match compiler/src/starters.ts).
    function _expected(string memory name, uint16 x) internal pure returns (bool) {
        bytes32 n = keccak256(bytes(name));
        if (n == keccak256("BASIC_SAFETY")) {
            return _all(x, LatchBits.LP_LOCKED | LatchBits.TOP10_LT_40 | LatchBits.DEV_NO_SELL_7D);
        }
        if (n == keccak256("REVENUE_AGENTS")) {
            return _all(x, LatchBits.AGENT_LINKED | LatchBits.REV_GT_0 | LatchBits.LP_LOCKED);
        }
        if (n == keccak256("STRICT")) {
            return _all(
                x,
                LatchBits.AGENT_LINKED | LatchBits.REV_GT_0 | LatchBits.LP_LOCKED | LatchBits.TOP10_LT_25
                    | LatchBits.DEV_NO_SELL_7D
            ) && (x & (LatchBits.LATCH_LOCKED | LatchBits.AGE_GE_30D)) != 0;
        }
        if (n == keccak256("UNLOCK_T1")) {
            return _all(x, LatchBits.AGE_GE_7D | LatchBits.LP_LOCKED | LatchBits.HOLDERS_GE_100);
        }
        if (n == keccak256("UNLOCK_T2")) {
            return _all(x, LatchBits.AGE_GE_30D | LatchBits.REV_GE_10 | LatchBits.HOLDERS_GE_300 | LatchBits.LP_LOCKED);
        }
        revert("unknown starter");
    }

    function _all(uint16 x, uint16 mask) internal pure returns (bool) {
        return x & mask == mask;
    }
}
