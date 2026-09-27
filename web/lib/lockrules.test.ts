import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalStep, blockers, clearsThreshold, explainRevert, formatAmount, lockedAfterFee, minDepositForThreshold, type LockDraft } from './lockrules.ts';

const E18 = 10n ** 18n;
const base: LockDraft = {
  connected: true, chainId: 196, tokenValid: true, symbol: 'IGGY', decimals: 18,
  amount: 5_500_000n * E18, balance: 6_183_061n * E18, beneficiaryValid: true,
  tranches: [{ filterId: 4, bps: 10_000 }],
  filters: [{ id: 4, name: 'UNLOCK_T1', stateful: false }, { id: 6, name: 'STICKY_SAFETY', stateful: true }],
  transferable: { ok: true },
};

test('valid draft has no blockers', () => assert.deepEqual(blockers(base), []));

test('the observed failure: 65% plus three empty rows is blocked with each reason', () => {
  const b = blockers({ ...base, tranches: [{ filterId: 4, bps: 6500 }, { filterId: 0, bps: 0 }, { filterId: 0, bps: 0 }, { filterId: 0, bps: 0 }] });
  assert.ok(b.includes('Tranches sum to 65%, must be 100%.'));
  assert.ok(b.includes('Tranche 2 has no unlock circuit selected.'));
  assert.ok(b.includes('Tranche 4 has no unlock circuit selected.'));
});

test('stateful filter, zero amount, over balance, wrong chain, curve-only token', () => {
  assert.match(blockers({ ...base, tranches: [{ filterId: 6, bps: 10_000 }] }).join(), /STICKY_SAFETY is a stateful/);
  assert.match(blockers({ ...base, amount: 0n }).join(), /greater than zero/);
  assert.match(blockers({ ...base, amount: 7_000_000n * E18 }).join(), /more than your balance \(6,183,061 IGGY\)/);
  assert.match(blockers({ ...base, chainId: 1 }).join(), /Switch your wallet to X Layer/);
  assert.match(blockers({ ...base, transferable: { ok: false, reason: explainRevert('CurveOnly', [], { symbol: 'IGGY' }) } }).join(), /bonding curve/);
  assert.match(blockers({ ...base, tranches: [{ filterId: 9, bps: 10_000 }] }).join(), /not registered/);
});

test('approval steps', () => {
  assert.equal(approvalStep(0n, 5n), 'needed');
  assert.equal(approvalStep(4n, 5n), 'needed');
  assert.equal(approvalStep(5n, 5n), 'ok');
  assert.equal(approvalStep(9n, 5n), 'reapprove-lower');
  assert.equal(approvalStep(undefined, 5n), 'unknown');
});

test('minimum deposit is exact: it clears 5% and one unit less does not', () => {
  const cases: [bigint, bigint][] = [[1_000_000_000n * E18, 0n], [1_000_000_000n * E18, 3n * E18], [999_999_999_999n, 0n], [123_456_789n, 1n], [10_001n, 0n], [7n, 0n]];
  for (let s = 1n; s < 3000n; s += 7n) cases.push([s, 0n], [s, s / 50n]);
  for (const [supply, already] of cases) {
    const a = minDepositForThreshold(supply, 500, already, 50);
    if (clearsThreshold(already, supply, 500)) { assert.equal(a, 0n); continue; }
    assert.ok(clearsThreshold(already + lockedAfterFee(a, 50), supply, 500), `supply ${supply}: ${a} should clear`);
    assert.ok(!clearsThreshold(already + lockedAfterFee(a - 1n, 50), supply, 500), `supply ${supply}: ${a - 1n} should not clear`);
  }
});

test('IGGY: 6,183,061 of 1,000,000,000 does not clear 5%; the minimum is shown rounded up', () => {
  const supply = 1_000_000_000n * E18;
  const lock = 6_183_061n * E18;
  assert.equal(clearsThreshold(lockedAfterFee(lock, 50), supply, 500), false);
  const min = minDepositForThreshold(supply, 500, 0n, 50);
  assert.equal(formatAmount(min, 18, 'IGGY', 'up', 0), '50,251,257 IGGY');
  assert.ok(clearsThreshold(lockedAfterFee(50_251_257n * E18, 50), supply, 500));
});

test('formatting', () => {
  assert.equal(formatAmount(50251256281407035175879397n, 18, 'IGGY'), '50,251,256.28 IGGY');
  assert.equal(formatAmount(50251256281407035175879397n, 18, 'IGGY', 'up'), '50,251,256.29 IGGY');
  assert.equal(formatAmount(10_000_000n * E18, 18), '10,000,000');
  assert.equal(formatAmount(9_950_000n * E18, 18, 'X'), '9,950,000 X');
  assert.equal(formatAmount(1n, 18, 'X', 'up'), '0.01 X');
  assert.equal(formatAmount(1234567n, 6, 'USDT'), '1.23 USDT');
});

test('every LatchLock custom error has a sentence', () => {
  for (const e of ['FeeTooHigh', 'BadConfig']) assert.match(explainRevert(e), /reverted with/); // constructor-only
  for (const e of ['ZeroAddress', 'ZeroAmount', 'BadTranches', 'UnknownFilter', 'StatefulUnlock', 'UnknownLock', 'BadTranche', 'AlreadyReleased', 'StillLatched', 'CurveOnly', 'ERC20InsufficientAllowance', 'SafeERC20FailedOperation'])
    assert.doesNotMatch(explainRevert(e, [1n, 2n, 3n]), /reverted with/, e);
});
