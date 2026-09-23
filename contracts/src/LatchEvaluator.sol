// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NetlistVM} from "./vendor/tapeout/lib/NetlistVM.sol";
import {SSTORE2} from "./vendor/tapeout/lib/SSTORE2.sol";
import {LatchBits} from "./LatchBits.sol";
import {ILatchEvaluator} from "./interfaces/ILatch.sol";

/// @title LatchEvaluator — the sealed evaluation path for Latch circuits.
/// @notice A stateless wrapper around TapeOut's own NetlistVM (vendored verbatim, MIT). No storage, no owner, no proxy,
///         no selfdestruct, no constructor arguments, view functions only. Once deployed it evaluates a given netlist
///         identically forever, whatever happens to TapeOut's upgradeable factory.
///
///         LatchLock releases through this contract only. LatchGate uses it for `checkLocal`, `verify` and `snapshot`,
///         and to validate netlists at registration.
contract LatchEvaluator is ILatchEvaluator {
    /// @notice Validates a 16-in / 1-out netlist and returns its size. Any REF element reverts
    ///         ("REF: target not a registered CPU"), so accepted netlists are self-contained.
    function analyze(bytes calldata nl)
        external
        view
        returns (uint256 nNand, uint256 nLatch, uint32 nState, uint32 gateCount)
    {
        return NetlistVM.analyze(nl, LatchBits.N_IN, LatchBits.N_OUT, address(0));
    }

    /// @notice Evaluates the netlist stored at an SSTORE2 `netlistPointer` for one step.
    /// @dev Meaningful only for pointers written by LatchGate.registerFilter, which checks the netlist with `analyze`.
    /// @param state latch state from the previous step (empty for combinational circuits)
    /// @param bits the 16-bit Latch input word
    function evaluate(address netlistPointer, bytes calldata state, uint16 bits)
        external
        view
        returns (bool pass, bytes memory newState)
    {
        bytes memory out;
        (newState, out) = NetlistVM.run(
            SSTORE2.read(netlistPointer), LatchBits.N_IN, LatchBits.N_OUT, state, LatchBits.pack(bits)
        );
        pass = uint8(out[0]) & 1 == 1;
    }
}
