// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ICPU} from "../../src/vendor/tapeout/interfaces/ICPU.sol";
import {NetlistVM} from "../../src/vendor/tapeout/lib/NetlistVM.sol";

/// @notice TapeOut processor + factory registry in one, evaluating with TapeOut's own (vendored) NetlistVM,
///         so semantics match mainnet exactly. No transistors/fees. `setEvil` simulates a malicious beacon
///         upgrade that inverts every output, to prove LatchLock's local path is immune.
contract MockTapeOut is ICPU {
    struct Circ {
        bytes nl;
        uint32 nIn;
        uint32 nOut;
        uint32 nState;
        uint32 gateCount;
    }

    mapping(uint256 => Circ) internal _c;
    uint256 public nextId;
    bool public evil;
    bool public gasBomb;

    event TapedOut(uint256 indexed circuitId, address indexed author, uint32 gateCount, uint32 nState);

    function isCPU(address a) external view returns (bool) {
        return a == address(this);
    }

    function setEvil(bool v) external {
        evil = v;
    }

    function setGasBomb(bool v) external {
        gasBomb = v;
    }

    function tapeout(bytes calldata nl, uint32 nIn, uint32 nOut) external returns (uint256 id) {
        (,, uint32 nState, uint32 gateCount) = NetlistVM.analyze(nl, nIn, nOut, address(this));
        id = ++nextId;
        _c[id] = Circ(nl, nIn, nOut, nState, gateCount);
        emit TapedOut(id, msg.sender, gateCount, nState);
    }

    /// @dev Test hook: overwrite a circuit's stored netlist (simulates an upgrade changing `netlist()`).
    function tamper(uint256 id, bytes calldata nl) external {
        _c[id].nl = nl;
    }

    function circuitInfo(uint256 id) external view returns (uint32, uint32, uint32, uint32) {
        Circ storage c = _c[id];
        require(c.nOut != 0, "no circuit");
        return (c.nIn, c.nOut, c.nState, c.gateCount);
    }

    function netlist(uint256 id) external view returns (bytes memory) {
        require(_c[id].nOut != 0, "no circuit");
        return _c[id].nl;
    }

    function transistors() external pure returns (address) {
        return address(0);
    }

    function eval(uint256 id, bytes calldata inputs) external view returns (bytes memory outputs) {
        Circ storage c = _c[id];
        require(c.nOut != 0, "no circuit");
        require(c.nState == 0, "has latch: use step");
        _maybeBomb();
        (, outputs) = NetlistVM.run(c.nl, c.nIn, c.nOut, "", inputs);
        if (evil) outputs[0] = bytes1(uint8(outputs[0]) ^ 1);
    }

    function step(uint256 id, bytes calldata state, bytes calldata inputs)
        external
        view
        returns (bytes memory newState, bytes memory outputs)
    {
        Circ storage c = _c[id];
        require(c.nOut != 0, "no circuit");
        _maybeBomb();
        (newState, outputs) = NetlistVM.run(c.nl, c.nIn, c.nOut, state, inputs);
        if (evil) outputs[0] = bytes1(uint8(outputs[0]) ^ 1);
    }

    function _maybeBomb() internal view {
        if (!gasBomb) return;
        uint256 x;
        while (gasleft() > 1000) x++;
    }
}
