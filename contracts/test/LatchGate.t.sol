// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.t.sol";
import {LatchGate} from "../src/LatchGate.sol";
import {LatchBits} from "../src/LatchBits.sol";
import {ICPU} from "../src/vendor/tapeout/interfaces/ICPU.sol";
import {MockERC20} from "./mocks/Tokens.sol";
import {LatchLock} from "../src/LatchLock.sol";

contract LatchGateTest is Base {
    address internal token = makeAddr("token");

    // ------------------------------------------------------------------ registration

    function test_startersRegistered() public view {
        assertEq(gate.filterCount(), 7);
        LatchGate.Filter memory f = gate.getFilter(filterId["STRICT"]);
        assertEq(f.nState, 0);
        assertGt(f.gateCount, 0);
        assertEq(keccak256(gate.netlistOf(filterId["STRICT"])), f.netlistHash);
        assertEq(gate.getFilter(filterId["STICKY_TEST"]).nState, 1);
    }

    function test_register_rejectsNonTapeOut() public {
        vm.expectRevert(abi.encodeWithSelector(LatchGate.NotTapeOutCircuit.selector, address(this)));
        gate.registerFilter(ICPU(address(this)), 1, "x", bytes32(0));
    }

    function test_register_rejectsHashMismatch() public {
        bytes memory nl = gate.netlistOf(filterId["BASIC_SAFETY"]);
        uint256 cid = tapeout.tapeout(nl, 16, 1);
        vm.expectRevert(abi.encodeWithSelector(LatchGate.NetlistMismatch.selector, bytes32(uint256(1)), keccak256(nl)));
        gate.registerFilter(ICPU(address(tapeout)), cid, "x", bytes32(uint256(1)));
    }

    function test_register_rejectsWrongShape() public {
        bytes memory nl = hex"00000002000003"; // NAND(in0, in1) with nIn=2
        uint256 cid = tapeout.tapeout(nl, 2, 1);
        vm.expectRevert(abi.encodeWithSelector(LatchGate.BadShape.selector, uint32(2), uint32(1)));
        gate.registerFilter(ICPU(address(tapeout)), cid, "x", keccak256(nl));
    }

    function test_register_rejectsRef() public {
        // A 16-in circuit that REFs BASIC_SAFETY's circuit (id 1) as a black box: valid on TapeOut, rejected here.
        bytes memory ins;
        for (uint256 i = 0; i < 16; i++) ins = abi.encodePacked(ins, uint24(2 + i));
        bytes memory nl = abi.encodePacked(uint8(2), address(tapeout), uint64(1), uint8(16), uint8(1), ins);
        uint256 cid = tapeout.tapeout(nl, 16, 1);
        vm.expectRevert(bytes("REF: target not a registered CPU"));
        gate.registerFilter(ICPU(address(tapeout)), cid, "ref", keccak256(nl));
    }

    function test_register_rejectsTooManyGates() public {
        bytes memory nl;
        for (uint256 i = 0; i < MAX_GATES + 1; i++) nl = abi.encodePacked(nl, uint8(0), uint24(2), uint24(3));
        uint256 cid = tapeout.tapeout(nl, 16, 1);
        vm.expectRevert(abi.encodeWithSelector(LatchGate.TooManyGates.selector, MAX_GATES + 1, MAX_GATES));
        gate.registerFilter(ICPU(address(tapeout)), cid, "big", keccak256(nl));
    }

    // ------------------------------------------------------------------ inputs

    function test_unknownTokenReverts() public {
        _post(makeAddr("other"), 0);
        vm.expectRevert(abi.encodeWithSelector(LatchGate.UnknownToken.selector, token));
        gate.inputs(token);
    }

    function test_ageBitsAreOnchain() public {
        _post(token, LatchBits.LP_LOCKED, uint64(block.timestamp), creator);
        assertEq(gate.inputs(token), LatchBits.LP_LOCKED);
        vm.warp(block.timestamp + 7 days);
        vm.prank(attestor);
        feed.heartbeat();
        assertEq(gate.inputs(token), LatchBits.LP_LOCKED | LatchBits.AGE_GE_7D);
        vm.warp(block.timestamp + 23 days);
        vm.prank(attestor);
        feed.heartbeat();
        assertEq(gate.inputs(token), LatchBits.LP_LOCKED | LatchBits.AGE_GE_7D | LatchBits.AGE_GE_30D);
    }

    function test_latchLockedBitFromLatchLock() public {
        MockERC20 t = new MockERC20(1_000_000e18);
        t.transfer(creator, 100_000e18);
        _post(address(t), 0, uint64(block.timestamp), creator);
        assertEq(gate.inputs(address(t)) & LatchBits.LATCH_LOCKED, 0);

        LatchLock.TrancheInput[] memory tr = new LatchLock.TrancheInput[](1);
        tr[0] = LatchLock.TrancheInput(uint64(filterId["UNLOCK_T1"]), 10_000);
        vm.startPrank(creator);
        t.approve(address(lock), type(uint256).max);
        lock.createLock(address(t), 40_000e18, beneficiary, tr); // 4% of supply < 5% threshold
        assertEq(gate.inputs(address(t)) & LatchBits.LATCH_LOCKED, 0);
        lock.createLock(address(t), 20_000e18, beneficiary, tr); // ~5.97% after fees
        vm.stopPrank();
        assertEq(gate.inputs(address(t)) & LatchBits.LATCH_LOCKED, LatchBits.LATCH_LOCKED);
    }

    // ------------------------------------------------------------------ evaluation

    /// Every starter filter, through both paths, matches the reference semantics for any attested bits and age.
    function testFuzz_startersMatchReference(uint16 attested, uint32 ageSeconds) public {
        attested &= LatchBits.ATTESTED_MASK;
        uint64 launch = uint64(block.timestamp - (ageSeconds % 60 days));
        _post(token, attested, launch, creator);
        uint16 x = gate.inputs(token);
        for (uint256 i = 0; i < starterNames.length; i++) {
            uint256 id = filterId[starterNames[i]];
            (bool pass, uint16 in1) = gate.check(token, id);
            (bool local, uint16 in2) = gate.checkLocal(token, id);
            assertEq(in1, x);
            assertEq(in2, x);
            assertEq(pass, _expected(starterNames[i], x), starterNames[i]);
            assertEq(local, pass, starterNames[i]);
        }
    }

    function test_staleFeedReverts() public {
        _post(token, LatchBits.LP_LOCKED);
        vm.warp(block.timestamp + MAX_AGE + 1);
        vm.expectRevert(LatchGate.FeedStale.selector);
        gate.check(token, filterId["BASIC_SAFETY"]);
        vm.expectRevert(LatchGate.FeedStale.selector);
        gate.checkLocal(token, filterId["BASIC_SAFETY"]);
        address[] memory ts = new address[](1);
        ts[0] = token;
        vm.expectRevert(LatchGate.FeedStale.selector);
        gate.checkMany(ts, filterId["BASIC_SAFETY"]);
    }

    function test_checkMany_unknownTokensFalse() public {
        uint16 good = LatchBits.LP_LOCKED | LatchBits.TOP10_LT_40 | LatchBits.DEV_NO_SELL_7D;
        _post(token, good);
        address[] memory ts = new address[](2);
        ts[0] = token;
        ts[1] = makeAddr("unknown");
        (bool[] memory p, uint16[] memory ins) = gate.checkMany(ts, filterId["BASIC_SAFETY"]);
        assertTrue(p[0]);
        assertEq(ins[0], good);
        assertFalse(p[1]);
        assertEq(ins[1], 0);
    }

    function test_unknownFilterReverts() public {
        _post(token, 0);
        vm.expectRevert(abi.encodeWithSelector(LatchGate.UnknownFilter.selector, 99));
        gate.check(token, 99);
    }

    /// Option C: if TapeOut's live logic changes, `check` follows it but `checkLocal` (used by LatchLock) does not.
    function test_evilUpgrade_localPathUnaffected() public {
        uint16 good = LatchBits.LP_LOCKED | LatchBits.TOP10_LT_40 | LatchBits.DEV_NO_SELL_7D;
        _post(token, good);
        uint256 id = filterId["BASIC_SAFETY"];
        tapeout.setEvil(true);
        (bool live,) = gate.check(token, id);
        (bool local,) = gate.checkLocal(token, id);
        assertFalse(live);
        assertTrue(local);
        (bool a, bool b,) = gate.verify(token, id);
        assertTrue(a != b, "verify must expose the divergence");
    }

    function test_tamperedNetlist_snapshotUnaffected() public {
        uint256 id = filterId["BASIC_SAFETY"];
        bytes memory before = gate.netlistOf(id);
        LatchGate.Filter memory f = gate.getFilter(id);
        tapeout.tamper(f.circuitId, hex"00000002000002");
        assertEq(gate.netlistOf(id), before);
    }

    function test_gasCap_bombReverts() public {
        _post(token, 0);
        tapeout.setGasBomb(true);
        vm.expectRevert(abi.encodeWithSelector(LatchGate.EvalFailed.selector, filterId["BASIC_SAFETY"]));
        gate.check{gas: 5_000_000}(token, filterId["BASIC_SAFETY"]);
        // local path does not touch TapeOut at all
        gate.checkLocal(token, filterId["BASIC_SAFETY"]);
    }

    function test_evalGas() public {
        _post(token, LatchBits.LP_LOCKED);
        for (uint256 i = 0; i < starterNames.length; i++) {
            uint256 id = filterId[starterNames[i]];
            uint256 g0 = gasleft();
            gate.check(token, id);
            uint256 g1 = gasleft();
            gate.checkLocal(token, id);
            uint256 g2 = gasleft();
            emit log_named_uint(string.concat(starterNames[i], " check gas"), g0 - g1);
            emit log_named_uint(string.concat(starterNames[i], " checkLocal gas"), g1 - g2);
            assertLt(g0 - g1, 150_000);
        }
    }

    // ------------------------------------------------------------------ snapshots

    function test_snapshotEmitsTransitions() public {
        uint256 id = filterId["BASIC_SAFETY"];
        uint16 good = LatchBits.LP_LOCKED | LatchBits.TOP10_LT_40 | LatchBits.DEV_NO_SELL_7D;
        _post(token, 0);
        vm.expectEmit(true, true, false, true);
        emit LatchGate.Latched(token, id, 0);
        gate.snapshot(token, id);

        vm.roll(block.number + 1);
        _post(token, good);
        vm.expectEmit(true, true, false, true);
        emit LatchGate.Unlatched(token, id, good);
        assertTrue(gate.snapshot(token, id));

        vm.roll(block.number + 1);
        vm.recordLogs();
        gate.snapshot(token, id); // unchanged: no event
        assertEq(vm.getRecordedLogs().length, 0);
    }

    // ------------------------------------------------------------------ stateful (latch) filters

    function test_sticky_holdsUntilReset() public {
        uint256 id = filterId["STICKY_TEST"]; // set: LP_LOCKED & TOP10_LT_40, reset: !DEV_NO_SELL_7D
        uint16 set = LatchBits.LP_LOCKED | LatchBits.TOP10_LT_40 | LatchBits.DEV_NO_SELL_7D;

        _post(token, LatchBits.DEV_NO_SELL_7D);
        assertFalse(_advance(id));

        _post(token, set);
        assertTrue(_advance(id));

        // concentration rises, LP data flickers: still trusted
        _post(token, LatchBits.DEV_NO_SELL_7D);
        assertTrue(_advance(id));
        (bool live,) = gate.check(token, id);
        assertTrue(live);

        // feed goes stale: latch filters keep the last snapshot instead of reverting
        vm.warp(block.timestamp + MAX_AGE + 1);
        (bool stale,) = gate.check(token, id);
        assertTrue(stale);
        vm.expectRevert(LatchGate.FeedStale.selector);
        gate.checkLocal(token, id);

        // dev sells: re-latched, and it stays latched
        _post(token, 0);
        assertFalse(_advance(id));
        _post(token, set & ~LatchBits.LP_LOCKED);
        assertFalse(_advance(id));
    }

    function test_sticky_resetWinsOverSet() public {
        uint256 id = filterId["STICKY_TEST"];
        _post(token, LatchBits.LP_LOCKED | LatchBits.TOP10_LT_40); // set + dev sold
        assertFalse(_advance(id));
    }

    function test_sticky_oneAdvancePerBlock() public {
        uint256 id = filterId["STICKY_TEST"];
        _post(token, LatchBits.LP_LOCKED | LatchBits.TOP10_LT_40 | LatchBits.DEV_NO_SELL_7D);
        assertTrue(gate.snapshot(token, id));
        _post(token, 0);
        assertTrue(gate.snapshot(token, id)); // same block: returns stored result
        vm.roll(block.number + 1);
        assertFalse(gate.snapshot(token, id));
    }

    function test_sticky_liveAndLocalAgree() public {
        uint256 id = filterId["STICKY_TEST"];
        _post(token, LatchBits.LP_LOCKED | LatchBits.TOP10_LT_40 | LatchBits.DEV_NO_SELL_7D);
        _advance(id);
        _post(token, LatchBits.DEV_NO_SELL_7D);
        (bool a, bool b,) = gate.verify(token, id);
        assertTrue(a);
        assertTrue(b);
    }

    function test_stickySafety_starter() public {
        uint256 id = filterId["STICKY_SAFETY"]; // set: TOP10_LT_40 & DEV_NO_SELL_7D & HOLDERS_GE_100
        uint16 curve = LatchBits.TOP10_LT_40 | LatchBits.DEV_NO_SELL_7D | LatchBits.HOLDERS_GE_100;
        _post(token, curve);
        assertTrue(_advance(id));
        _post(token, LatchBits.DEV_NO_SELL_7D); // holders drop, concentration rises: still trusted
        assertTrue(_advance(id));
        _post(token, curve & ~LatchBits.DEV_NO_SELL_7D); // dev sold: re-latched
        assertFalse(_advance(id));
        _post(token, curve); // dev sale ages out of the 7d window: trust can be earned again
        assertTrue(_advance(id));
    }

    /// LP_PULLED is final in the feed, so a launch that pulled LP can never re-earn STICKY_SAFETY.
    function test_stickySafety_lpPulledIsPermanent() public {
        uint256 id = filterId["STICKY_SAFETY"];
        uint16 curve = LatchBits.TOP10_LT_40 | LatchBits.DEV_NO_SELL_7D | LatchBits.HOLDERS_GE_100;
        _post(token, curve);
        assertTrue(_advance(id));
        _post(token, curve | LatchBits.LP_PULLED); // pull wins even while curve conditions hold
        assertFalse(_advance(id));
        _post(token, curve); // attestor omits the bit: the feed keeps it
        assertFalse(_advance(id));
        assertEq(gate.inputs(token) & LatchBits.LP_PULLED, LatchBits.LP_PULLED);
    }

    function _advance(uint256 id) internal returns (bool) {
        vm.roll(block.number + 1);
        return gate.snapshot(token, id);
    }
}
