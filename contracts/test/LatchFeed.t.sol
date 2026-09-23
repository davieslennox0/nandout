// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.t.sol";
import {LatchFeed} from "../src/LatchFeed.sol";
import {LatchBits} from "../src/LatchBits.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract LatchFeedTest is Base {
    address internal token = makeAddr("token");

    function test_bitSchemaMatchesCompiler() public view {
        string memory json = vm.readFile("test/fixtures/circuits.json");
        assertEq(vm.parseJsonUint(json, ".attestedMask"), LatchBits.ATTESTED_MASK);
        assertEq(vm.parseJsonUint(json, ".onchainMask"), LatchBits.ONCHAIN_MASK);
        assertEq(vm.parseJsonUint(json, ".bits.LATCH_LOCKED"), 7);
        assertEq(vm.parseJsonUint(json, ".bits.HOLDERS_GE_300"), 11);
        assertEq(vm.parseJsonUint(json, ".bits.LP_PULLED"), 12);
    }

    function test_onlyAttestorPosts() public {
        LatchFeed.Update[] memory u = new LatchFeed.Update[](0);
        vm.expectRevert(LatchFeed.NotAttestor.selector);
        feed.post(u);
        vm.expectRevert(LatchFeed.NotAttestor.selector);
        feed.heartbeat();
    }

    function test_onlyOwnerManagesAttestors() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        feed.setAttestor(address(this), true);
        vm.prank(owner);
        feed.setAttestor(attestor, false);
        assertFalse(feed.isAttestor(attestor));
    }

    function testFuzz_rejectsOnchainAndReservedBits(uint16 bits) public {
        vm.assume(bits & ~LatchBits.ATTESTED_MASK != 0);
        LatchFeed.Update[] memory u = new LatchFeed.Update[](1);
        u[0] = LatchFeed.Update(token, bits, uint64(block.timestamp), creator);
        vm.prank(attestor);
        vm.expectRevert(abi.encodeWithSelector(LatchFeed.NonAttestedBits.selector, token, bits));
        feed.post(u);
    }

    function test_launchAndCreatorAreWriteOnce() public {
        uint64 t0 = uint64(block.timestamp - 1 days);
        _post(token, LatchBits.LP_LOCKED, t0, creator);
        vm.warp(block.timestamp + 1 hours);
        _post(token, LatchBits.AGENT_LINKED, uint64(block.timestamp), makeAddr("other"));
        (uint16 bits, uint64 updatedAt, uint64 launchTime, address c) = feed.getBits(token);
        assertEq(bits, LatchBits.AGENT_LINKED);
        assertEq(updatedAt, block.timestamp);
        assertEq(launchTime, t0);
        assertEq(c, creator);
    }

    function test_rejectsBadFirstRegistration() public {
        LatchFeed.Update[] memory u = new LatchFeed.Update[](1);
        u[0] = LatchFeed.Update(token, 0, uint64(block.timestamp + 1), creator); // future launch
        vm.prank(attestor);
        vm.expectRevert(abi.encodeWithSelector(LatchFeed.BadLaunch.selector, token));
        feed.post(u);
        u[0] = LatchFeed.Update(token, 0, uint64(block.timestamp), address(0)); // no creator
        vm.prank(attestor);
        vm.expectRevert(abi.encodeWithSelector(LatchFeed.BadLaunch.selector, token));
        feed.post(u);
    }

    function test_freshness() public {
        assertFalse(feed.isFresh()); // never posted
        _post(token, 0);
        assertTrue(feed.isFresh());
        vm.warp(block.timestamp + MAX_AGE);
        assertTrue(feed.isFresh());
        vm.warp(block.timestamp + 1);
        assertFalse(feed.isFresh());
        vm.prank(attestor);
        feed.heartbeat();
        assertTrue(feed.isFresh());
    }
}
