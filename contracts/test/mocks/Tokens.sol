// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockERC20 is ERC20 {
    constructor(uint256 supply) ERC20("Mock", "MOCK") {
        _mint(msg.sender, supply);
    }
}

/// @notice Burns `feeBps` of every transfer (like many launchpad tax tokens).
contract FeeOnTransferToken is ERC20 {
    uint256 public immutable feeBps;

    constructor(uint256 supply, uint256 feeBps_) ERC20("Fee", "FEE") {
        feeBps = feeBps_;
        _mint(msg.sender, supply);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value * feeBps / 10_000;
            super._update(from, address(0), fee);
            value -= fee;
        }
        super._update(from, to, value);
    }
}

interface IReenterTarget {
    function release(uint256 lockId, uint256 trancheIdx) external returns (uint256);
}

/// @notice Tries to re-enter LatchLock.release from inside a transfer.
contract ReentrantToken is ERC20 {
    IReenterTarget public target;
    uint256 public lockId;
    uint256 public trancheIdx;
    bool public attempted;
    bool public reentered;

    constructor(uint256 supply) ERC20("Re", "RE") {
        _mint(msg.sender, supply);
    }

    function arm(IReenterTarget t, uint256 id, uint256 idx) external {
        target = t;
        lockId = id;
        trancheIdx = idx;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (address(target) != address(0) && from == address(target) && !attempted) {
            attempted = true;
            try target.release(lockId, trancheIdx) {
                reentered = true;
            } catch {}
        }
    }
}
