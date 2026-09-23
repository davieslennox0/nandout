import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BITS } from '@latch/compiler';
import { attest, excludedFor, holdings } from '../src/bits.ts';
import { IGNIX } from '../src/config.ts';
import type { Launch } from '../src/ignix.ts';
import type { LpInfo } from '../src/lp.ts';

const A = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as `0x${string}`;
const M = 1_000_000n * 10n ** 18n;
const HEAD = { number: 10_000_000, timestamp: 1_790_000_000 };

const launch = (over: Partial<Launch> = {}): Launch => ({
  tokenAddress: A(0xaaaa), creator: A(0xc), name: 'T', symbol: 'T', createdTime: '2026-09-01T00:00:00.000Z', createdTx: '0x',
  graduated: false, venue: 'v2', pair: null, poolId: null, lpTokenId: null, dividendTracker: A(0xd1), taxRouter: A(0xd2),
  splitter: null, holders: 0, asp: null, ...over,
});

const has = (bits: number, b: keyof typeof BITS) => (bits >> BITS[b]) & 1;

function book(extra: Record<string, bigint> = {}): Record<string, string> {
  const bal: Record<string, bigint> = {
    [IGNIX.launchpad]: 800n * M,
    '0x0000000000000000000000000000000000000000': 100n * M, // burned
    [A(0xd1)]: 50n * M, // dividend tracker (excluded)
    ...extra,
  };
  for (let i = 1; i <= 12; i++) bal[A(i)] = BigInt(i) * M; // 78M across 12 wallets
  return Object.fromEntries(Object.entries(bal).map(([k, v]) => [k, v.toString()]));
}

test('holdings: supply = minted − burned; top-10 share is of circulating (wallet-held) supply', () => {
  const h = holdings(book(), excludedFor(launch()));
  assert.equal(h.supply, 928n * M);
  assert.equal(h.circulating, 78n * M);
  assert.equal(h.holders, 12);
  assert.equal(h.top10, 75n * M); // 12+11+…+3
  assert.ok(Math.abs(h.top10Share - 75 / 78) < 1e-6);
});

test('holdings: a dev-only token is 100% concentrated, not "distributed"', () => {
  const l = launch();
  const h = holdings({ [IGNIX.launchpad]: (900n * M).toString(), [l.creator]: (100n * M).toString() }, excludedFor(l));
  assert.equal(h.top10Share, 1);
});

/** 200 equal wallets: top-10 = 5% of circulating. */
function spread(): Record<string, string> {
  const bal: Record<string, string> = { [IGNIX.launchpad]: (800n * M).toString() };
  for (let i = 1; i <= 200; i++) bal[A(0x1000 + i)] = M.toString();
  return bal;
}

test('holdings: LatchLock balance is excluded when its address is known', () => {
  const lock = A(0x10c);
  const h = holdings(book({ [lock]: 300n * M }), excludedFor(launch(), lock));
  assert.equal(h.top10, 75n * M);
});

test('attest: curve-phase launch', () => {
  const l = launch({ holders: 200 });
  const a = attest(l, holdings(spread(), excludedFor(l)), undefined, undefined, HEAD);
  assert.equal(has(a.bits, 'TOP10_LT_40'), 1);
  assert.equal(has(a.bits, 'TOP10_LT_25'), 1);
  assert.equal(has(a.bits, 'DEV_NO_SELL_7D'), 1);
  assert.equal(has(a.bits, 'LP_LOCKED'), 0);
  assert.equal(has(a.bits, 'LP_PULLED'), 0);
  assert.equal(has(a.bits, 'HOLDERS_GE_100'), 1);
  assert.equal(has(a.bits, 'HOLDERS_GE_300'), 0);
  assert.match(a.reasons.LP_LOCKED!, /bonding curve/);
  const concentrated = attest(l, holdings(book(), excludedFor(l)), undefined, undefined, HEAD);
  assert.equal(has(concentrated.bits, 'TOP10_LT_40'), 0);
});

test('attest: dev sell inside vs outside the 7-day window', () => {
  const l = launch();
  const h = holdings(book(), excludedFor(l));
  assert.equal(has(attest(l, h, undefined, HEAD.number - 3600, HEAD).bits, 'DEV_NO_SELL_7D'), 0);
  assert.equal(has(attest(l, h, undefined, HEAD.number - 8 * 86400, HEAD).bits, 'DEV_NO_SELL_7D'), 1);
});

test('attest: agent + revenue + LP bits', () => {
  const l = launch({ graduated: true, pair: A(0xbeef), asp: { id: 7, name: 'x', matched: 'linked', rev: 8.8 } });
  const lp: LpInfo = { venue: 'v2', locked: 10n, supply: 11n, holder: null, peak: 10n, lpLocked: true, lpPulled: false };
  const a = attest(l, holdings(book(), excludedFor(l)), lp, undefined, HEAD);
  assert.equal(has(a.bits, 'AGENT_LINKED'), 1);
  assert.equal(has(a.bits, 'REV_GT_0'), 1);
  assert.equal(has(a.bits, 'REV_GE_10'), 0);
  assert.equal(has(a.bits, 'LP_LOCKED'), 1);
  const pulled = attest(l, holdings(book(), excludedFor(l)), { ...lp, locked: 1n, lpLocked: false, lpPulled: true }, undefined, HEAD);
  assert.equal(has(pulled.bits, 'LP_LOCKED'), 0);
  assert.equal(has(pulled.bits, 'LP_PULLED'), 1);
});

test('attest: never sets on-chain or reserved bits', () => {
  const l = launch({ graduated: true, pair: A(0xbeef), asp: { id: 1, name: 'x', matched: 'linked', rev: 5000 } });
  const a = attest(l, holdings(book(), excludedFor(l)), undefined, undefined, HEAD);
  for (const b of ['LATCH_LOCKED', 'AGE_GE_7D', 'AGE_GE_30D'] as const) assert.equal(has(a.bits, b), 0);
  assert.equal(a.bits & 0xe000, 0);
});
