// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {LatchBits} from "./LatchBits.sol";
import {ILatchFeed} from "./interfaces/ILatch.sol";

/// @title LatchFeed — attested, off-chain-derived input bits for Ignix launches.
/// @notice Trust assumption: attestors are trusted to report agent/revenue/LP/holder/dev-sell bits honestly.
///         On-chain bits (LATCH_LOCKED, AGE_*) can never be written here; LatchGate computes them.
///         Launch time and creator are write-once per token. LP_PULLED is final: once set it stays set, whatever
///         later posts say.
///
///         Freshness is global: every post (or heartbeat) proves the attestor re-evaluated the whole index,
///         and only tokens whose bits changed are written. `isFresh()` is false once `maxAge` passes
///         without a post.
///
///         The owner can add/remove attestors and nothing else. `maxAge` is immutable.
contract LatchFeed is ILatchFeed, Ownable2Step {
    struct Entry {
        uint16 bits;
        uint64 updatedAt;
        uint64 launchTime;
        address creator;
    }

    struct Update {
        address token;
        uint16 bits;
        uint64 launchTime; // ignored once set
        address creator; // ignored once set
    }

    uint64 public immutable maxAge;
    uint64 public lastHeartbeat;
    mapping(address => bool) public isAttestor;
    mapping(address => Entry) internal _entries;

    event AttestorSet(address indexed attestor, bool enabled);
    event LaunchRegistered(address indexed token, address indexed creator, uint64 launchTime);
    event BitsUpdated(address indexed token, uint16 bits, uint64 updatedAt);
    event Heartbeat(address indexed attestor, uint64 at);

    error NotAttestor();
    error NonAttestedBits(address token, uint16 bits);
    error BadLaunch(address token);
    error ZeroMaxAge();

    modifier onlyAttestor() {
        if (!isAttestor[msg.sender]) revert NotAttestor();
        _;
    }

    constructor(address owner_, uint64 maxAge_) Ownable(owner_) {
        if (maxAge_ == 0) revert ZeroMaxAge();
        maxAge = maxAge_;
    }

    function setAttestor(address attestor, bool enabled) external onlyOwner {
        isAttestor[attestor] = enabled;
        emit AttestorSet(attestor, enabled);
    }

    /// @notice Writes changed tokens and refreshes the global heartbeat.
    function post(Update[] calldata updates) external onlyAttestor {
        uint64 nowTs = uint64(block.timestamp);
        for (uint256 i = 0; i < updates.length; i++) {
            Update calldata u = updates[i];
            if (u.bits & ~LatchBits.ATTESTED_MASK != 0) revert NonAttestedBits(u.token, u.bits);
            Entry storage e = _entries[u.token];
            if (e.launchTime == 0) {
                if (u.token == address(0) || u.creator == address(0) || u.launchTime == 0 || u.launchTime > nowTs) {
                    revert BadLaunch(u.token);
                }
                e.launchTime = u.launchTime;
                e.creator = u.creator;
                emit LaunchRegistered(u.token, u.creator, u.launchTime);
            }
            e.bits = u.bits | (e.bits & LatchBits.LP_PULLED);
            e.updatedAt = nowTs;
            emit BitsUpdated(u.token, e.bits, nowTs);
        }
        lastHeartbeat = nowTs;
        emit Heartbeat(msg.sender, nowTs);
    }

    /// @notice Refreshes freshness when nothing changed.
    function heartbeat() external onlyAttestor {
        lastHeartbeat = uint64(block.timestamp);
        emit Heartbeat(msg.sender, lastHeartbeat);
    }

    function isFresh() public view returns (bool) {
        return lastHeartbeat != 0 && block.timestamp - lastHeartbeat <= maxAge;
    }

    /// @return bits attested bits only; updatedAt last write for this token; launchTime/creator write-once (0 = unknown token)
    function getBits(address token)
        external
        view
        returns (uint16 bits, uint64 updatedAt, uint64 launchTime, address creator)
    {
        Entry storage e = _entries[token];
        return (e.bits, e.updatedAt, e.launchTime, e.creator);
    }
}
