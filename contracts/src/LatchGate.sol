// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ICPU} from "./vendor/tapeout/interfaces/ICPU.sol";
import {SSTORE2} from "./vendor/tapeout/lib/SSTORE2.sol";
import {LatchBits} from "./LatchBits.sol";
import {ILatchEvaluator, ILatchFeed, ILatchGate, ILatchLock, ICircuitRegistryView} from "./interfaces/ILatch.sol";

/// @title LatchGate — "nothing moves on Ignix until the logic says so".
/// @notice A filter is a TapeOut circuit (16 inputs → 1 output). Two evaluation paths (docs/RECON.md §4, Option C):
///         - `check` / `checkMany` call the live TapeOut circuit (`eval`, or `step` for latch filters) with a gas cap.
///         - `checkLocal` evaluates the netlist snapshotted at registration through LatchEvaluator (a sealed,
///           stateless wrapper of TapeOut's NetlistVM). TapeOut's factory is still upgradeable; this path is not.
///           LatchLock releases through LatchEvaluator directly.
///         Stateful (latch) filters keep their state here, advanced by `snapshot` using LatchEvaluator only.
///         No owner, no admin, no upgrades.
contract LatchGate is ILatchGate {
    struct Filter {
        ICPU cpu;
        uint64 circuitId;
        uint32 gateCount;
        uint32 nState;
        address netlistPointer; // SSTORE2 copy of the netlist, immutable
        bytes32 netlistHash;
        address registrant;
        string name;
    }

    struct Slot {
        bytes state; // latch state (stateful filters only)
        uint16 inputs; // inputs at the last snapshot
        bool pass; // output at the last snapshot
        bool seen;
        uint64 atBlock;
    }

    uint256 public constant AGE_7D = 7 days;
    uint256 public constant AGE_30D = 30 days;

    ILatchFeed public immutable feed;
    ICircuitRegistryView public immutable registry; // TapeOut CircuitFactory
    ILatchLock public immutable lock;
    ILatchEvaluator public immutable evaluator;
    uint32 public immutable maxGates;
    uint256 public immutable evalGasCap;

    Filter[] internal _filters; // filterId = index + 1
    mapping(uint256 => mapping(address => Slot)) internal _slots; // filterId => token => slot

    event FilterRegistered(
        uint256 indexed filterId,
        address indexed cpu,
        uint256 indexed circuitId,
        string name,
        uint32 gateCount,
        uint32 nState,
        bytes32 netlistHash,
        address registrant
    );
    event Unlatched(address indexed token, uint256 indexed filterId, uint16 inputs);
    event Latched(address indexed token, uint256 indexed filterId, uint16 inputs);
    event Advanced(address indexed token, uint256 indexed filterId, uint16 inputs, bool pass, bytes state);

    error NotTapeOutCircuit(address cpu);
    error BadShape(uint32 nIn, uint32 nOut);
    error TooManyGates(uint32 gateCount, uint32 maxGates);
    error NetlistMismatch(bytes32 expected, bytes32 actual);
    error NetlistShape();
    error UnknownFilter(uint256 filterId);
    error UnknownToken(address token);
    error FeedStale();
    error EvalFailed(uint256 filterId);
    error LockMismatch();
    error EvaluatorMismatch();

    constructor(
        ILatchFeed feed_,
        ICircuitRegistryView registry_,
        ILatchLock lock_,
        ILatchEvaluator evaluator_,
        uint32 maxGates_,
        uint256 evalGasCap_
    ) {
        // LatchLock is deployed first against this contract's predicted address; confirm the pairing and that both
        // contracts evaluate with the same LatchEvaluator.
        if (address(lock_.gate()) != address(this)) revert LockMismatch();
        if (address(lock_.evaluator()) != address(evaluator_)) revert EvaluatorMismatch();
        feed = feed_;
        registry = registry_;
        lock = lock_;
        evaluator = evaluator_;
        maxGates = maxGates_;
        evalGasCap = evalGasCap_;
    }

    // ------------------------------------------------------------------ registry

    /// @notice Permissionless. Registers a taped-out TapeOut circuit as a filter and snapshots its netlist.
    /// @param expectedHash keccak256 of the netlist you compiled (the compiler prints it). Protects against
    ///        registering a netlist that differs from what you verified.
    function registerFilter(ICPU cpu, uint256 circuitId, string calldata name, bytes32 expectedHash)
        external
        returns (uint256 filterId)
    {
        if (!registry.isCPU(address(cpu))) revert NotTapeOutCircuit(address(cpu));
        (uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount) = cpu.circuitInfo(circuitId);
        if (nIn != LatchBits.N_IN || nOut != LatchBits.N_OUT) revert BadShape(nIn, nOut);
        if (gateCount > maxGates) revert TooManyGates(gateCount, maxGates);

        (address pointer, bytes32 h) = _snapshotNetlist(cpu, circuitId, expectedHash, nState, gateCount);
        _filters.push(
            Filter({
                cpu: cpu,
                circuitId: uint64(circuitId),
                gateCount: gateCount,
                nState: nState,
                netlistPointer: pointer,
                netlistHash: h,
                registrant: msg.sender,
                name: name
            })
        );
        filterId = _filters.length;
        emit FilterRegistered(filterId, address(cpu), circuitId, name, gateCount, nState, h, msg.sender);
    }

    function _snapshotNetlist(ICPU cpu, uint256 circuitId, bytes32 expectedHash, uint32 nState, uint32 gateCount)
        internal
        returns (address pointer, bytes32 h)
    {
        bytes memory nl = cpu.netlist(circuitId);
        h = keccak256(nl);
        if (h != expectedHash) revert NetlistMismatch(expectedHash, h);
        // registry = address(0): any REF reverts, so the snapshot is self-contained and evaluates identically forever.
        (uint256 nNand, uint256 nLatch, uint32 aState, uint32 aGates) = evaluator.analyze(nl);
        if (aState != nState || aGates != gateCount || nNand + nLatch != gateCount) revert NetlistShape();
        pointer = SSTORE2.write(nl);
    }

    function filterCount() external view returns (uint256) {
        return _filters.length;
    }

    function filterExists(uint256 filterId) public view returns (bool) {
        return filterId != 0 && filterId <= _filters.length;
    }

    /// @notice True for latch filters (nState > 0), recorded from TapeOut's circuitInfo at registration.
    function isStateful(uint256 filterId) external view returns (bool) {
        return _filter(filterId).nState != 0;
    }

    function getFilter(uint256 filterId) external view returns (Filter memory) {
        return _filter(filterId);
    }

    /// @notice SSTORE2 address of the immutable netlist snapshot (what LatchEvaluator evaluates).
    function netlistPointer(uint256 filterId) external view returns (address) {
        return _filter(filterId).netlistPointer;
    }

    function netlistOf(uint256 filterId) external view returns (bytes memory) {
        return SSTORE2.read(_filter(filterId).netlistPointer);
    }

    function slotOf(address token, uint256 filterId) external view returns (Slot memory) {
        return _slots[filterId][token];
    }

    // ------------------------------------------------------------------ inputs

    /// @notice Attested bits merged with on-chain bits. Reverts for tokens the feed has never seen.
    function inputs(address token) public view returns (uint16) {
        (bool known, uint16 bits) = _inputs(token);
        if (!known) revert UnknownToken(token);
        return bits;
    }

    function _inputs(address token) internal view returns (bool known, uint16 bits) {
        (uint16 attested,, uint64 launchTime, address creator) = feed.getBits(token);
        if (launchTime == 0) return (false, 0);
        bits = attested & LatchBits.ATTESTED_MASK;
        if (lock.isLocked(token, creator)) bits |= LatchBits.LATCH_LOCKED;
        uint256 age = block.timestamp > launchTime ? block.timestamp - launchTime : 0;
        if (age >= AGE_7D) bits |= LatchBits.AGE_GE_7D;
        if (age >= AGE_30D) bits |= LatchBits.AGE_GE_30D;
        return (true, bits);
    }

    // ------------------------------------------------------------------ live TapeOut path

    /// @notice Evaluates the live TapeOut circuit. Combinational filters revert when the feed is stale;
    ///         latch filters return their last snapshotted result instead (that is the point of a latch).
    function check(address token, uint256 filterId) external view returns (bool pass, uint16 in_) {
        Filter storage f = _filter(filterId);
        if (!feed.isFresh()) {
            if (f.nState == 0) revert FeedStale();
            Slot storage s = _slots[filterId][token];
            return (s.pass, s.inputs);
        }
        in_ = inputs(token);
        pass = _evalTapeOut(f, filterId, _slots[filterId][token].state, in_);
    }

    /// @notice Batch version for vaults/frontends. Unknown tokens return pass = false instead of reverting.
    function checkMany(address[] calldata tokens, uint256 filterId)
        external
        view
        returns (bool[] memory passes, uint16[] memory ins)
    {
        Filter storage f = _filter(filterId);
        bool fresh = feed.isFresh();
        if (!fresh && f.nState == 0) revert FeedStale();
        passes = new bool[](tokens.length);
        ins = new uint16[](tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            Slot storage s = _slots[filterId][tokens[i]];
            if (!fresh) {
                (passes[i], ins[i]) = (s.pass, s.inputs);
                continue;
            }
            (bool known, uint16 bits) = _inputs(tokens[i]);
            if (!known) continue;
            ins[i] = bits;
            passes[i] = _evalTapeOut(f, filterId, s.state, bits);
        }
    }

    function _evalTapeOut(Filter storage f, uint256 filterId, bytes memory state, uint16 bits)
        internal
        view
        returns (bool)
    {
        bytes memory call_ = f.nState == 0
            ? abi.encodeCall(ICPU.eval, (f.circuitId, LatchBits.pack(bits)))
            : abi.encodeCall(ICPU.step, (f.circuitId, state, LatchBits.pack(bits)));
        (bool ok, bytes memory ret) = address(f.cpu).staticcall{gas: evalGasCap}(call_);
        if (!ok) revert EvalFailed(filterId);
        bytes memory out;
        if (f.nState == 0) {
            out = abi.decode(ret, (bytes));
        } else {
            (, out) = abi.decode(ret, (bytes, bytes));
        }
        return out.length > 0 && uint8(out[0]) & 1 == 1;
    }

    // ------------------------------------------------------------------ local (snapshot) path

    /// @notice Evaluates the immutable snapshot of the filter. Always requires a fresh feed.
    ///         For latch filters this is the result the next `snapshot` would store.
    function checkLocal(address token, uint256 filterId) public view returns (bool pass, uint16 in_) {
        Filter storage f = _filter(filterId);
        if (!feed.isFresh()) revert FeedStale();
        in_ = inputs(token);
        (, pass) = _evalLocal(f, _slots[filterId][token].state, in_);
    }

    /// @notice Both paths side by side. A mismatch means the live TapeOut logic diverged from the snapshot.
    function verify(address token, uint256 filterId)
        external
        view
        returns (bool tapeoutPass, bool localPass, uint16 in_)
    {
        Filter storage f = _filter(filterId);
        if (!feed.isFresh()) revert FeedStale();
        in_ = inputs(token);
        bytes memory state = _slots[filterId][token].state;
        tapeoutPass = _evalTapeOut(f, filterId, state, in_);
        (, localPass) = _evalLocal(f, state, in_);
    }

    function _evalLocal(Filter storage f, bytes memory state, uint16 bits)
        internal
        view
        returns (bytes memory newState, bool pass)
    {
        (pass, newState) = evaluator.evaluate(f.netlistPointer, state, bits);
    }

    // ------------------------------------------------------------------ snapshots

    /// @notice Permissionless. Records the current result (local path) for indexing; for latch filters this is
    ///         what advances the stored state. At most one advance per (token, filter) per block.
    function snapshot(address token, uint256 filterId) public returns (bool pass) {
        Filter storage f = _filter(filterId);
        Slot storage s = _slots[filterId][token];
        if (s.seen && s.atBlock == block.number) return s.pass;
        if (!feed.isFresh()) revert FeedStale();
        uint16 bits = inputs(token);
        bytes memory newState;
        (newState, pass) = _evalLocal(f, s.state, bits);

        bool changed = !s.seen || s.pass != pass;
        s.inputs = bits;
        s.pass = pass;
        s.seen = true;
        s.atBlock = uint64(block.number);
        if (f.nState != 0) {
            s.state = newState;
            emit Advanced(token, filterId, bits, pass, newState);
        }
        if (changed) {
            if (pass) emit Unlatched(token, filterId, bits);
            else emit Latched(token, filterId, bits);
        }
    }

    function snapshotMany(address[] calldata tokens, uint256 filterId) external {
        for (uint256 i = 0; i < tokens.length; i++) {
            (bool known,) = _inputs(tokens[i]);
            if (known) snapshot(tokens[i], filterId);
        }
    }

    function _filter(uint256 filterId) internal view returns (Filter storage) {
        if (!filterExists(filterId)) revert UnknownFilter(filterId);
        return _filters[filterId - 1];
    }
}
