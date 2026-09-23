// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ILatchEvaluator, ILatchGate, ILatchLock} from "./interfaces/ILatch.sol";

/// @title LatchLock — creator allocations released only when an unlock circuit passes.
/// @notice Trust guarantee: after `createLock` nothing about a lock can change. There is no owner, no admin
///         withdraw, no pause, no circuit swap and no upgrade path. Tranches release only to the beneficiary,
///         only when its unlock circuit passes. The circuit is evaluated by LatchEvaluator (sealed: no owner, no
///         storage, no upgrade path) on the netlist snapshotted at filter registration, never by TapeOut's upgradeable
///         contracts. Inputs come from LatchGate.inputs (ownerless). Anyone may trigger a release.
///
///         Fee: `feeBps` of the amount actually received, paid in kind to `treasury` at creation. Both immutable.
///
///         Unlock circuits must be combinational. A latch filter would carry one bad attestation forward forever,
///         and a release is irreversible; a combinational condition always reflects the current attested state.
///
///         Liveness: releases need a fresh LatchFeed. If every attestor stops, releases wait until one resumes.
///
///         Not supported: rebasing tokens (balances that change without transfers).
contract LatchLock is ILatchLock, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant MAX_FEE_BPS = 100;
    uint256 public constant MAX_TRANCHES = 8;

    struct TrancheInput {
        uint64 filterId;
        uint16 bps;
    }

    struct Tranche {
        uint64 filterId;
        uint16 bps;
        bool released;
        uint256 amount;
    }

    struct Lock {
        address token;
        address depositor;
        address beneficiary;
        uint64 createdAt;
        uint256 amount; // locked after fee
        uint256 released;
    }

    ILatchGate public immutable gate;
    ILatchEvaluator public immutable evaluator;
    address public immutable treasury;
    uint16 public immutable feeBps;
    /// @notice Share of total supply a creator must keep locked for the LATCH_LOCKED bit.
    uint16 public immutable minLockBps;

    Lock[] internal _locks; // lockId = index + 1
    mapping(uint256 => Tranche[]) internal _tranches;
    mapping(address => mapping(address => uint256)) public lockedOf; // token => depositor => still locked
    mapping(address => uint256[]) internal _locksByToken;
    mapping(address => uint256[]) internal _locksByBeneficiary;

    event LockCreated(
        uint256 indexed lockId,
        address indexed token,
        address indexed beneficiary,
        address depositor,
        uint256 received,
        uint256 locked
    );
    event TrancheCreated(uint256 indexed lockId, uint256 indexed trancheIdx, uint64 filterId, uint16 bps, uint256 amount);
    event FeeCharged(uint256 indexed lockId, address indexed token, address indexed treasury, uint256 fee);
    event Released(
        uint256 indexed lockId, uint256 indexed trancheIdx, address indexed beneficiary, uint256 amount, uint16 inputs
    );

    error FeeTooHigh();
    error BadConfig();
    error ZeroAddress();
    error ZeroAmount();
    error BadTranches();
    error UnknownFilter(uint64 filterId);
    error StatefulUnlock(uint64 filterId);
    error UnknownLock(uint256 lockId);
    error BadTranche(uint256 trancheIdx);
    error AlreadyReleased();
    error StillLatched(uint16 inputs);
    error FeedStale();

    constructor(ILatchGate gate_, ILatchEvaluator evaluator_, address treasury_, uint16 feeBps_, uint16 minLockBps_) {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        if (address(gate_) == address(0) || address(evaluator_) == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }
        if (minLockBps_ == 0 || minLockBps_ > 10_000) revert BadConfig();
        gate = gate_;
        evaluator = evaluator_;
        treasury = treasury_;
        feeBps = feeBps_;
        minLockBps = minLockBps_;
    }

    /// @notice Pulls `amount` of `token` from the caller and locks it (minus the fee) into tranches.
    /// @dev Records the amount actually received, so fee-on-transfer tokens are handled.
    function createLock(address token, uint256 amount, address beneficiary, TrancheInput[] calldata tranches)
        external
        nonReentrant
        returns (uint256 lockId)
    {
        if (token == address(0) || beneficiary == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        uint256 n = tranches.length;
        if (n == 0 || n > MAX_TRANCHES) revert BadTranches();
        uint256 bpsSum;
        for (uint256 i = 0; i < n; i++) {
            if (tranches[i].bps == 0) revert BadTranches();
            if (!gate.filterExists(tranches[i].filterId)) revert UnknownFilter(tranches[i].filterId);
            if (gate.isStateful(tranches[i].filterId)) revert StatefulUnlock(tranches[i].filterId);
            bpsSum += tranches[i].bps;
        }
        if (bpsSum != 10_000) revert BadTranches();

        IERC20 t = IERC20(token);
        uint256 before = t.balanceOf(address(this));
        t.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = t.balanceOf(address(this)) - before;
        uint256 fee = received * feeBps / 10_000;
        uint256 locked = received - fee;
        if (locked == 0) revert ZeroAmount();

        _locks.push(
            Lock({
                token: token,
                depositor: msg.sender,
                beneficiary: beneficiary,
                createdAt: uint64(block.timestamp),
                amount: locked,
                released: 0
            })
        );
        lockId = _locks.length;
        _locksByToken[token].push(lockId);
        _locksByBeneficiary[beneficiary].push(lockId);
        lockedOf[token][msg.sender] += locked;

        Tranche[] storage ts = _tranches[lockId];
        uint256 assigned;
        for (uint256 i = 0; i < n; i++) {
            uint256 amt = i == n - 1 ? locked - assigned : locked * tranches[i].bps / 10_000;
            assigned += amt;
            ts.push(Tranche({filterId: tranches[i].filterId, bps: tranches[i].bps, released: false, amount: amt}));
            emit TrancheCreated(lockId, i, tranches[i].filterId, tranches[i].bps, amt);
        }

        emit LockCreated(lockId, token, beneficiary, msg.sender, received, locked);
        if (fee > 0) {
            t.safeTransfer(treasury, fee);
            emit FeeCharged(lockId, token, treasury, fee);
        }
    }

    /// @notice Anyone can call. Releases a tranche to its beneficiary iff its unlock circuit passes.
    function release(uint256 lockId, uint256 trancheIdx) external nonReentrant returns (uint256 amount) {
        Lock storage l = _lock(lockId);
        Tranche[] storage ts = _tranches[lockId];
        if (trancheIdx >= ts.length) revert BadTranche(trancheIdx);
        Tranche storage tr = ts[trancheIdx];
        if (tr.released) revert AlreadyReleased();

        // Evaluation goes through LatchEvaluator only. Unlock filters are combinational (enforced at createLock),
        // so no latch state is involved.
        if (!gate.feed().isFresh()) revert FeedStale();
        uint16 in_ = gate.inputs(l.token);
        (bool pass,) = evaluator.evaluate(gate.netlistPointer(tr.filterId), "", in_);
        if (!pass) revert StillLatched(in_);

        amount = tr.amount;
        tr.released = true;
        l.released += amount;
        lockedOf[l.token][l.depositor] -= amount;

        IERC20(l.token).safeTransfer(l.beneficiary, amount);
        emit Released(lockId, trancheIdx, l.beneficiary, amount, in_);
    }

    /// @notice LATCH_LOCKED: `creator` still has at least `minLockBps` of the token's supply locked here.
    function isLocked(address token, address creator) external view returns (bool) {
        uint256 locked = lockedOf[token][creator];
        if (locked == 0) return false;
        // Gas-capped so a hostile token cannot break LatchGate.inputs for other tokens.
        (bool ok, bytes memory ret) = token.staticcall{gas: 50_000}(abi.encodeCall(IERC20.totalSupply, ()));
        if (!ok || ret.length < 32) return false;
        uint256 supply = abi.decode(ret, (uint256));
        if (supply > type(uint256).max / 10_000) return false;
        return locked * 10_000 >= supply * minLockBps;
    }

    // ------------------------------------------------------------------ views

    function lockCount() external view returns (uint256) {
        return _locks.length;
    }

    function getLock(uint256 lockId) external view returns (Lock memory, Tranche[] memory) {
        return (_lock(lockId), _tranches[lockId]);
    }

    function locksByToken(address token) external view returns (uint256[] memory) {
        return _locksByToken[token];
    }

    function locksByBeneficiary(address beneficiary) external view returns (uint256[] memory) {
        return _locksByBeneficiary[beneficiary];
    }

    function _lock(uint256 lockId) internal view returns (Lock storage) {
        if (lockId == 0 || lockId > _locks.length) revert UnknownLock(lockId);
        return _locks[lockId - 1];
    }
}
