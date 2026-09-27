// What a proposed lock would change: filter results now vs. after the lock, computed with the same circuits and the
// same LATCH_LOCKED rule LatchGate applies (depositor must be the recorded creator; still-locked ≥ minLockBps of supply).
import { NextResponse } from 'next/server';
import { isAddress, type Address } from 'viem';
import { BITS } from '@latch/compiler';
import { deployed } from '@/lib/config';
import { explainFilter } from '@/lib/lockstatus';
import { parseToken, readFilters, readToken } from '@/lib/lockview';

export const dynamic = 'force-dynamic';

const LATCH_LOCKED = 1 << BITS.LATCH_LOCKED;
const filterJson = (f: Awaited<ReturnType<typeof readFilters>>[number]) => ({ id: f.id, name: f.name, starter: f.starter, stateful: f.stateful, circuitId: String(f.circuitId) });

export async function GET(req: Request) {
  if (!deployed) return NextResponse.json({ error: 'not deployed' }, { status: 503 });
  const q = new URL(req.url).searchParams;
  const token = parseToken(q.get('token') ?? '');
  if (!token) return NextResponse.json({ filters: (await readFilters()).map(filterJson) });

  const wallet = q.get('wallet');
  let amount = 0n;
  try { amount = BigInt(q.get('amount') ?? '0'); } catch { /* invalid → 0 */ }
  const v = await readToken(token);
  const base = { token, block: String(v.block), known: v.known, filters: v.filters.map(filterJson), symbol: v.symbol, decimals: v.decimals };
  if (!v.known || v.inputs === null) return NextResponse.json({ ...base, reason: 'Not registered in the Nandout feed: no filter can evaluate this token, and a lock would not set LATCH_LOCKED.' });

  const received = amount - (amount * BigInt(v.feeBps)) / 10_000n;
  const isCreator = Boolean(wallet && isAddress(wallet) && v.creator && wallet.toLowerCase() === v.creator.toLowerCase());
  const lockedAfter = v.creatorLocked + (isCreator ? received : 0n);
  const supply = v.totalSupply ?? 0n;
  const clears = supply > 0n && lockedAfter * 10_000n >= supply * BigInt(v.minLockBps);
  const after = clears ? v.inputs | LATCH_LOCKED : v.inputs;
  // Smallest deposit (before the fee) that would clear the threshold for the creator.
  const need = supply * BigInt(v.minLockBps) / 10_000n - v.creatorLocked;
  const needGross = need > 0n ? (need * 10_000n + BigInt(10_000 - v.feeBps) - 1n) / BigInt(10_000 - v.feeBps) : 0n;

  let latchNote: string;
  if (v.latchLocked) latchNote = 'LATCH_LOCKED is already on for this token.';
  else if (!wallet || !isAddress(wallet)) latchNote = 'Connect the creator wallet to see whether this lock turns on LATCH_LOCKED.';
  else if (!isCreator) latchNote = `This wallet is not the creator recorded for this launch (${v.creator}). Its lock is valid and binding, but it does not turn on LATCH_LOCKED.`;
  else if (clears) latchNote = `This lock takes the creator to ${Number((lockedAfter * 10_000n) / (supply || 1n)) / 100}% of supply locked, at or above ${v.minLockBps / 100}%, so LATCH_LOCKED turns on.`;
  else latchNote = `After this lock the creator would have ${Number((lockedAfter * 10_000n) / (supply || 1n)) / 100}% of supply locked, below ${v.minLockBps / 100}%. LATCH_LOCKED stays off; depositing at least ${needGross.toString()} (raw units, fee included) would turn it on.`;

  const results = v.filters.map((f) => {
    const prev = v.prevPass[f.id] ?? 0;
    const b = explainFilter(f, v.inputs!, prev);
    const a = explainFilter(f, after, prev);
    const chain = v.checks[f.id];
    return { ...filterJson(f), chain, before: b && { pass: b.pass, kind: b.kind, why: b.why.map((r) => r.text) }, after: a && { pass: a.pass, kind: a.kind, why: a.why.map((r) => r.text) } };
  });
  return NextResponse.json({
    ...base,
    creator: v.creator,
    isCreator,
    latchLockedNow: v.latchLocked,
    latchLockedAfter: clears,
    latchNote,
    needGross: needGross.toString(),
    fresh: v.fresh,
    results,
  });
}
