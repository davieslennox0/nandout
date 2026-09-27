import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BITS } from '@latch/compiler';
import { attest, excludedFor, holdings } from '../src/bits.ts';
import type { Launch } from '../src/ignix.ts';
import { finish, type LpState } from '../src/lp.ts';
import { emptyRegistry, launchesForCycle, mergeIndex, normalizeSingle, recordAttestations, refreshFromApi, selectRefresh } from '../src/registry.ts';

const A = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as `0x${string}`;
const M = 1_000_000n * 10n ** 18n;
const HEAD = { number: 10_000_000, timestamp: 1_790_000_000 };
const launch = (n: number, over: Partial<Launch> = {}): Launch => ({
  tokenAddress: A(0xa000 + n), creator: A(0xc), name: `T${n}`, symbol: `T${n}`, createdTime: '2026-09-01T00:00:00.000Z', createdTx: '0x',
  graduated: false, venue: 'v2', pair: null, poolId: null, lpTokenId: null, dividendTracker: null, taxRouter: null,
  splitter: null, holders: 0, asp: null, ...over,
});
const has = (bits: number, b: keyof typeof BITS) => (bits >> BITS[b]) & 1;

test('a launch that leaves the index is still attested, and its bits follow new on-chain data', () => {
  const r = emptyRegistry();
  const old = launch(1);
  mergeIndex(r, [old, launch(2)], 1000);
  mergeIndex(r, [launch(2)], 2000); // `old` fell out of the capped index
  const e = r.entries[old.tokenAddress];
  assert.equal(e.inIndex, false);
  assert.ok(launchesForCycle(r).some((l) => l.tokenAddress === old.tokenAddress), 'still in the cycle');

  const concentrated = { [old.creator]: (100n * M).toString() };
  const spread = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [A(0x5000 + i), M.toString()]));
  const before = attest(old, holdings(concentrated, excludedFor(old)), undefined, undefined, HEAD);
  const after = attest(old, holdings(spread, excludedFor(old)), undefined, undefined, HEAD);
  recordAttestations(r, [{ token: old.tokenAddress, bits: before.bits }], 2000);
  recordAttestations(r, [{ token: old.tokenAddress, bits: after.bits }], 2600);
  assert.notEqual(before.bits, after.bits);
  assert.equal(has(after.bits, 'HOLDERS_GE_100'), 1);
  assert.equal(e.lastChangeAt, 2600);
  assert.equal(e.lastAttestedAt, 2600);
});

test('an out-of-index token backing an active lock is refreshed every cycle, even past the budget', async () => {
  const r = emptyRegistry();
  const ls = Array.from({ length: 10 }, (_, i) => launch(i));
  mergeIndex(r, ls, 1000);
  mergeIndex(r, [], 2000); // all ten dropped out
  const lockedToken = ls[7].tokenAddress;
  for (const cycle of [3000, 3600, 4200]) {
    const pick = selectRefresh(r, new Set([lockedToken]), cycle, 2);
    assert.ok(pick.includes(lockedToken), `locked token refreshed at ${cycle}`);
    await refreshFromApi(r, pick, cycle, async (t) => launch(ls.findIndex((l) => l.tokenAddress === t)));
    assert.equal(r.entries[lockedToken].apiRefreshedAt, cycle);
  }
  // Round-robin: the locked token takes one budget slot; the other slot rotates through different unlocked tokens.
  const rotated = Object.entries(r.entries).filter(([t, e]) => t !== lockedToken && (e.apiRefreshedAt ?? 0) > 2000).length;
  assert.equal(rotated, 3, 'three cycles reached three different unlocked tokens');
});

test('an API failure keeps the last known data and records the error', async () => {
  const r = emptyRegistry();
  const l = launch(1, { asp: { id: 9, name: 'x', matched: 'linked', rev: 3 } });
  mergeIndex(r, [l], 1000);
  mergeIndex(r, [], 2000);
  await refreshFromApi(r, [l.tokenAddress], 2000, async () => { throw new Error('HTTP 502'); });
  assert.equal(r.entries[l.tokenAddress].launch?.asp?.rev, 3);
  assert.equal(r.entries[l.tokenAddress].apiError, 'HTTP 502');
});

test('LP_PULLED survives a refresh cycle where the source no longer shows it', () => {
  const state: LpState = { peak: {} };
  const t = A(0xbeef);
  finish(state, t, 'v2', 1000n, 1100n, null); // locked at peak
  const pulled = finish(state, t, 'v2', 100n, 1100n, null); // 90% pulled
  assert.equal(pulled.lpPulled, true);
  const refilled = finish(state, t, 'v2', 5000n, 5500n, null); // LP comes back, source looks clean
  assert.equal(refilled.lpPulled, true, 'pull is permanent');
  assert.equal(refilled.lpLocked, false);
  const l = launch(1, { graduated: true, pair: A(0x9) });
  const a = attest(l, holdings({}, excludedFor(l)), refilled, undefined, HEAD);
  assert.equal(has(a.bits, 'LP_PULLED'), 1);
});

test('AGE_GE_30D: a launch that left the index before 30 days keeps its launch time; age stays on-chain', () => {
  const r = emptyRegistry();
  const young = launch(1, { createdTime: new Date((HEAD.timestamp - 20 * 86_400) * 1000).toISOString() });
  mergeIndex(r, [young], 1000);
  mergeIndex(r, [], 2000);
  const kept = launchesForCycle(r).find((l) => l.tokenAddress === young.tokenAddress)!;
  const a = attest(kept, holdings({}, excludedFor(kept)), undefined, undefined, HEAD);
  // The attestor posts the original launch time (write-once in LatchFeed) and never sets AGE bits itself;
  // LatchGate derives AGE_GE_30D from that launch time and block.timestamp, so it turns on at day 30 regardless.
  assert.equal(a.launchTime, HEAD.timestamp - 20 * 86_400);
  assert.equal(has(a.bits, 'AGE_GE_7D') | has(a.bits, 'AGE_GE_30D'), 0);
});

test('seeding from previously indexed tokens creates fetchable placeholders', () => {
  const r = emptyRegistry();
  mergeIndex(r, [launch(1)], 1000, [A(0xa001), A(0xdead1)]);
  const p = r.entries[A(0xdead1)];
  assert.equal(p.launch, null);
  assert.equal(p.inIndex, false);
  assert.deepEqual(selectRefresh(r, new Set(), 1000, 5), [A(0xdead1)], 'never-fetched first');
});

test('single-launch payload is normalised to the index shape (holderCount, not the top-holder list)', () => {
  const l = normalizeSingle({ code: 200, data: { ...launch(3), holders: [{ address: A(1), amount: '1', pct: 100 }], holderCount: 42 } });
  assert.equal(l.holders, 42);
  assert.throws(() => normalizeSingle({ code: 404 }));
});
