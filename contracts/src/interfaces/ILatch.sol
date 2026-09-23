// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ILatchFeed {
    function getBits(address token)
        external
        view
        returns (uint16 bits, uint64 updatedAt, uint64 launchTime, address creator);
    function isFresh() external view returns (bool);
}

interface ILatchEvaluator {
    function analyze(bytes calldata nl)
        external
        view
        returns (uint256 nNand, uint256 nLatch, uint32 nState, uint32 gateCount);
    function evaluate(address netlistPointer, bytes calldata state, uint16 bits)
        external
        view
        returns (bool pass, bytes memory newState);
}

interface ILatchLock {
    function gate() external view returns (ILatchGate);
    function evaluator() external view returns (ILatchEvaluator);
    function isLocked(address token, address creator) external view returns (bool);
}

interface ILatchGate {
    function feed() external view returns (ILatchFeed);
    function evaluator() external view returns (ILatchEvaluator);
    function inputs(address token) external view returns (uint16);
    function netlistPointer(uint256 filterId) external view returns (address);
    function checkLocal(address token, uint256 filterId) external view returns (bool pass, uint16 inputs);
    function filterExists(uint256 filterId) external view returns (bool);
    function isStateful(uint256 filterId) external view returns (bool);
    function lock() external view returns (ILatchLock);
}

/// @dev TapeOut CircuitFactory registry view (factory.isCPU).
interface ICircuitRegistryView {
    function isCPU(address) external view returns (bool);
}
