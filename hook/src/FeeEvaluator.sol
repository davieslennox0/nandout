// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NetlistVM} from "latch/vendor/tapeout/lib/NetlistVM.sol";
import {SSTORE2} from "latch/vendor/tapeout/lib/SSTORE2.sol";

/// @notice Phase 0 benchmark evaluator: stateless, ownerless, runs a frozen netlist with TapeOut's own NetlistVM.
///         7 fact bits in, 2 tier bits out. `tableOf` derives the full truth table from the same netlist, so a hook can
///         freeze the circuit's answers at registration and look them up per swap instead of re-running the VM.
contract FeeEvaluator {
    uint32 internal constant N_IN = 7;
    uint32 internal constant N_OUT = 2;

    function tierOf(address netlistPointer, uint8 facts) public view returns (uint8) {
        (, bytes memory out) = NetlistVM.run(SSTORE2.read(netlistPointer), N_IN, N_OUT, "", abi.encodePacked(facts));
        return uint8(out[0]) & 3;
    }

    /// @notice 128 entries x 2 bits = one word. Entry i (bits 2i..2i+1) is the tier for fact word i.
    function computeTable(address netlistPointer) external view returns (uint256 table) {
        bytes memory nl = SSTORE2.read(netlistPointer);
        for (uint256 i = 0; i < 128; i++) {
            (, bytes memory out) = NetlistVM.run(nl, N_IN, N_OUT, "", abi.encodePacked(uint8(i)));
            table |= uint256(uint8(out[0]) & 3) << (2 * i);
        }
    }
}
