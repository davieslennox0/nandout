// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.t.sol";
import {LatchLock} from "../src/LatchLock.sol";
import {LatchGate} from "../src/LatchGate.sol";
import {LatchBits} from "../src/LatchBits.sol";
import {ILatchGate} from "../src/interfaces/ILatch.sol";
import {MockERC20, FeeOnTransferToken, ReentrantToken, IReenterTarget} from "./mocks/Tokens.sol";

contract LatchLockTest is Base {
    uint256 internal constant SUPPLY = 1_000_000_000e18;
    MockERC20 internal token;
    uint16 internal constant T1_BITS = LatchBits.LP_LOCKED | LatchBits.HOLDERS_GE_100; // + AGE_GE_7D on-chain

    function setUp() public override {
        super.setUp();
        token = new MockERC20(SUPPLY);
        token.transfer(creator, SUPPLY / 10);
        vm.prank(creator);
        token.approve(address(lock), type(uint256).max);
        _post(address(token), 0, uint64(block.timestamp), creator);
    }

    function _tranches2() internal view returns (LatchLock.TrancheInput[] memory tr) {
        tr = new LatchLock.TrancheInput[](2);
        tr[0] = LatchLock.TrancheInput(uint64(filterId["UNLOCK_T1"]), 4_000);
        tr[1] = LatchLock.TrancheInput(uint64(filterId["UNLOCK_T2"]), 6_000);
    }

    function _create(uint256 amount) internal returns (uint256) {
        vm.prank(creator);
        return lock.createLock(address(token), amount, beneficiary, _tranches2());
    }

    function _passT1() internal {
        vm.warp(block.timestamp + 7 days);
        _post(address(token), T1_BITS);
    }

    // ------------------------------------------------------------------ config

    function test_constructorBounds() public {
        vm.expectRevert(LatchLock.FeeTooHigh.selector);
        new LatchLock(ILatchGate(address(gate)), treasury, 101, 500);
        vm.expectRevert(LatchLock.ZeroAddress.selector);
        new LatchLock(ILatchGate(address(gate)), address(0), 50, 500);
        vm.expectRevert(LatchLock.BadConfig.selector);
        new LatchLock(ILatchGate(address(gate)), treasury, 50, 0);
    }

    // ------------------------------------------------------------------ create

    function test_create_chargesFeeAndSplits() public {
        uint256 amount = 10_000_000e18;
        vm.expectEmit(true, true, true, true);
        emit LatchLock.FeeCharged(1, address(token), treasury, 50_000e18);
        uint256 id = _create(amount);
        (LatchLock.Lock memory l, LatchLock.Tranche[] memory ts) = lock.getLock(id);
        assertEq(l.amount, 9_950_000e18);
        assertEq(token.balanceOf(treasury), 50_000e18);
        assertEq(token.balanceOf(address(lock)), 9_950_000e18);
        assertEq(ts[0].amount, 3_980_000e18);
        assertEq(ts[1].amount, 5_970_000e18);
        assertEq(lock.lockedOf(address(token), creator), 9_950_000e18);
        assertEq(l.depositor, creator);
        assertEq(l.beneficiary, beneficiary);
    }

    function testFuzz_trancheMath(uint256 amount, uint16[8] memory raw, uint8 n) public {
        n = uint8(bound(n, 1, 8));
        amount = bound(amount, 1_000, SUPPLY / 10);
        LatchLock.TrancheInput[] memory tr = new LatchLock.TrancheInput[](n);
        uint256 left = 10_000;
        for (uint256 i = 0; i < n; i++) {
            uint256 remaining = n - i - 1;
            uint256 bps = i == n - 1 ? left : bound(raw[i], 1, left - remaining);
            tr[i] = LatchLock.TrancheInput(uint64(filterId["UNLOCK_T1"]), uint16(bps));
            left -= bps;
        }
        vm.prank(creator);
        uint256 id = lock.createLock(address(token), amount, beneficiary, tr);
        (LatchLock.Lock memory l, LatchLock.Tranche[] memory ts) = lock.getLock(id);
        uint256 fee = amount * FEE_BPS / 10_000;
        assertEq(l.amount, amount - fee);
        assertEq(token.balanceOf(treasury), fee);
        uint256 sum;
        for (uint256 i = 0; i < n; i++) {
            sum += ts[i].amount;
            if (i < n - 1) assertEq(ts[i].amount, l.amount * tr[i].bps / 10_000);
        }
        assertEq(sum, l.amount, "tranches must sum exactly to the locked amount");
    }

    function test_create_rejectsBadTranches() public {
        LatchLock.TrancheInput[] memory tr = new LatchLock.TrancheInput[](1);
        tr[0] = LatchLock.TrancheInput(uint64(filterId["UNLOCK_T1"]), 9_999);
        vm.prank(creator);
        vm.expectRevert(LatchLock.BadTranches.selector);
        lock.createLock(address(token), 1e18, beneficiary, tr);

        tr[0] = LatchLock.TrancheInput(99, 10_000);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(LatchLock.UnknownFilter.selector, uint64(99)));
        lock.createLock(address(token), 1e18, beneficiary, tr);

        vm.prank(creator);
        vm.expectRevert(LatchLock.BadTranches.selector);
        lock.createLock(address(token), 1e18, beneficiary, new LatchLock.TrancheInput[](0));

        LatchLock.TrancheInput[] memory nine = new LatchLock.TrancheInput[](9);
        vm.prank(creator);
        vm.expectRevert(LatchLock.BadTranches.selector);
        lock.createLock(address(token), 1e18, beneficiary, nine);

        vm.prank(creator);
        vm.expectRevert(LatchLock.ZeroAddress.selector);
        lock.createLock(address(token), 1e18, address(0), _tranches2());
    }

    function test_create_rejectsStatefulUnlock() public {
        uint64 sticky = uint64(filterId["STICKY_SAFETY"]);
        LatchLock.TrancheInput[] memory tr = new LatchLock.TrancheInput[](2);
        tr[0] = LatchLock.TrancheInput(uint64(filterId["UNLOCK_T1"]), 5_000);
        tr[1] = LatchLock.TrancheInput(sticky, 5_000);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(LatchLock.StatefulUnlock.selector, sticky));
        lock.createLock(address(token), 1e18, beneficiary, tr);
        assertTrue(gate.isStateful(sticky));
        assertFalse(gate.isStateful(filterId["UNLOCK_T1"]));
    }

    function test_create_feeOnTransferRecordsReceived() public {
        FeeOnTransferToken fot = new FeeOnTransferToken(SUPPLY, 300); // 3% transfer tax
        fot.transfer(creator, 1_000_000e18); // creator receives 970,000
        vm.startPrank(creator);
        fot.approve(address(lock), type(uint256).max);
        uint256 id = lock.createLock(address(fot), 100_000e18, beneficiary, _tranches2());
        vm.stopPrank();
        uint256 received = 97_000e18;
        uint256 fee = received * FEE_BPS / 10_000;
        (LatchLock.Lock memory l,) = lock.getLock(id);
        assertEq(l.amount, received - fee);
        // treasury transfer is itself taxed; the lock still holds exactly what it recorded
        assertEq(fot.balanceOf(address(lock)), received - fee);
        assertEq(fot.balanceOf(treasury), fee - fee * 300 / 10_000);
    }

    // ------------------------------------------------------------------ release

    function test_release_onlyWhenCircuitPasses() public {
        uint256 id = _create(1_000_000e18);
        vm.expectRevert(abi.encodeWithSelector(LatchLock.StillLatched.selector, uint16(0)));
        lock.release(id, 0);

        _passT1();
        uint256 amount = lock.release(id, 0);
        assertEq(amount, 398_000e18);
        assertEq(token.balanceOf(beneficiary), 398_000e18);
        assertEq(lock.lockedOf(address(token), creator), 995_000e18 - 398_000e18);

        vm.expectRevert(LatchLock.AlreadyReleased.selector);
        lock.release(id, 0);
        // T2 still latched (needs age 30d, revenue, 300 holders)
        vm.expectRevert();
        lock.release(id, 1);
    }

    function testFuzz_release_anyoneCallsFundsOnlyToBeneficiary(address caller) public {
        vm.assume(caller != beneficiary && caller != address(lock) && caller != address(0));
        uint256 id = _create(1_000_000e18);
        _passT1();
        uint256 callerBefore = token.balanceOf(caller);
        vm.prank(caller);
        lock.release(id, 0);
        assertEq(token.balanceOf(caller), callerBefore);
        assertEq(token.balanceOf(beneficiary), 398_000e18);
    }

    function test_release_staleFeedBlocks() public {
        uint256 id = _create(1_000_000e18);
        _passT1();
        vm.warp(block.timestamp + MAX_AGE + 1);
        vm.expectRevert(LatchGate.FeedStale.selector);
        lock.release(id, 0);
    }

    /// Option C: a malicious TapeOut upgrade that makes every live eval pass cannot release funds.
    function test_release_ignoresEvilTapeOut() public {
        uint256 id = _create(1_000_000e18);
        _post(address(token), 0);
        tapeout.setEvil(true);
        (bool live,) = gate.check(address(token), filterId["UNLOCK_T1"]);
        assertTrue(live, "live path is fooled");
        vm.expectRevert(abi.encodeWithSelector(LatchLock.StillLatched.selector, uint16(0)));
        lock.release(id, 0);
    }

    function test_release_unknownLockAndTranche() public {
        vm.expectRevert(abi.encodeWithSelector(LatchLock.UnknownLock.selector, 1));
        lock.release(1, 0);
        uint256 id = _create(1e18);
        vm.expectRevert(abi.encodeWithSelector(LatchLock.BadTranche.selector, 2));
        lock.release(id, 2);
    }

    function test_release_reentrancyBlocked() public {
        ReentrantToken re = new ReentrantToken(SUPPLY);
        _post(address(re), 0, uint64(block.timestamp), address(this));
        re.approve(address(lock), type(uint256).max);
        LatchLock.TrancheInput[] memory tr = new LatchLock.TrancheInput[](2);
        tr[0] = LatchLock.TrancheInput(uint64(filterId["UNLOCK_T1"]), 5_000);
        tr[1] = LatchLock.TrancheInput(uint64(filterId["UNLOCK_T1"]), 5_000);
        uint256 id = lock.createLock(address(re), 1_000e18, beneficiary, tr);

        vm.warp(block.timestamp + 7 days);
        _post(address(re), T1_BITS);
        re.arm(IReenterTarget(address(lock)), id, 1);
        lock.release(id, 0);
        assertTrue(re.attempted());
        assertFalse(re.reentered(), "nested release must fail");
        (, LatchLock.Tranche[] memory ts) = lock.getLock(id);
        assertFalse(ts[1].released);
        // and it can still be released normally afterwards
        lock.release(id, 1);
        assertEq(re.balanceOf(beneficiary), 995e18);
    }

    function test_isLocked_dropsAfterRelease() public {
        uint256 id = _create(SUPPLY / 10); // 10% of supply → 9.95% locked
        assertTrue(lock.isLocked(address(token), creator));
        assertFalse(lock.isLocked(address(token), beneficiary));
        _passT1();
        lock.release(id, 0); // 60% of it remains = 5.97% ≥ 5%
        assertTrue(lock.isLocked(address(token), creator));
    }

    function test_lockIndexes() public {
        uint256 a = _create(1e18);
        uint256 b = _create(2e18);
        assertEq(lock.lockCount(), 2);
        uint256[] memory byToken = lock.locksByToken(address(token));
        uint256[] memory byBen = lock.locksByBeneficiary(beneficiary);
        assertEq(byToken.length, 2);
        assertEq(byToken[1], b);
        assertEq(byBen[0], a);
    }
}
