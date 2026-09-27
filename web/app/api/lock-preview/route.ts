// What a proposed lock would change: filter results now vs. after the lock, computed with the same circuits and the
// same LATCH_LOCKED rule LatchGate applies (depositor must be the recorded creator; still-locked ≥ minLockBps of supply).
import { NextResponse } from 'next/server';
import { decodeErrorResult, encodeFunctionData, isAddress, parseAbi, type Address, type Hex } from 'viem';
import { BITS } from '@latch/compiler';
import { DEPLOYMENT, deployed } from '@/lib/config';
import { clearsThreshold, explainRevert, formatAmount, lockedAfterFee, minDepositForThreshold, pctFloor } from '@/lib/lockrules';
import { explainFilter } from '@/lib/lockstatus';
import { client, ignixStatus, parseToken, readFilters, readToken } from '@/lib/lockview';

export const dynamic = 'force-dynamic';

const LATCH_LOCKED = 1 << BITS.LATCH_LOCKED;
const probeAbi = parseAbi([
  'function transfer(address, uint256) returns (bool)',
  'error CurveOnly()',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error ERC20InvalidReceiver(address receiver)',
]);

/** Can this wallet move the token into LatchLock at all? Simulates a 1-unit transfer from the wallet (eth_call, no tx). */
async function probeTransfer(token: Address, wallet: Address, symbol: string) {
  try {
    const data = encodeFunctionData({ abi: probeAbi, functionName: 'transfer', args: [DEPLOYMENT.lock!, 1n] });
    await client.call({ account: wallet, to: token, data });
    return { ok: true as const };
  } catch (e) {
    const raw = findRevertData(e);
    let name: string | undefined;
    try { if (raw) name = decodeErrorResult({ abi: probeAbi, data: raw }).errorName; } catch { /* unknown selector */ }
    if (name === 'ERC20InsufficientBalance') return { ok: true as const }; // no balance: reported by the amount check instead
    return { ok: false as const, error: name ?? raw?.slice(0, 10) ?? 'reverted', reason: name ? explainRevert(name, [], { symbol }) : `${symbol} refuses transfers from this wallet to LatchLock (revert ${raw?.slice(0, 10) ?? 'without data'}), so it cannot be locked.` };
  }
}
function findRevertData(e: unknown): Hex | undefined {
  let cur: any = e;
  for (let i = 0; cur && i < 8; i++, cur = cur.cause) {
    const d = cur.data?.data ?? cur.data;
    if (typeof d === 'string' && d.startsWith('0x')) return d as Hex;
  }
  return undefined;
}
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

  const sym = v.symbol ?? 'tokens';
  const f = (x: bigint, round: 'down' | 'up' = 'down') => formatAmount(x, v.decimals, sym, round);
  const [transfer, ignix] = await Promise.all([
    wallet && isAddress(wallet) ? probeTransfer(token, wallet as Address, sym) : Promise.resolve(undefined),
    ignixStatus(token),
  ]);
  if (transfer && !transfer.ok && transfer.error === 'CurveOnly' && ignix.progress !== null) {
    transfer.reason += ` It is ${Math.round(ignix.progress * 100)}% of the way along its curve.`;
  }

  const locked = lockedAfterFee(amount, v.feeBps);
  const isCreator = Boolean(wallet && isAddress(wallet) && v.creator && wallet.toLowerCase() === v.creator.toLowerCase());
  const lockedAfter = v.creatorLocked + (isCreator ? locked : 0n);
  const supply = v.totalSupply ?? 0n;
  const clears = clearsThreshold(lockedAfter, supply, v.minLockBps);
  const after = clears ? v.inputs | LATCH_LOCKED : v.inputs;
  const need = minDepositForThreshold(supply, v.minLockBps, v.creatorLocked, v.feeBps);
  const thr = `${v.minLockBps / 100}%`;

  let latchNote: string;
  if (v.latchLocked) latchNote = 'LATCH_LOCKED is already on for this token.';
  else if (!wallet || !isAddress(wallet)) latchNote = 'Connect the creator wallet to see whether this lock turns on LATCH_LOCKED.';
  else if (!isCreator) latchNote = `This wallet is not the creator recorded for this launch (${v.creator}). Its lock is valid and binding, but it does not turn on LATCH_LOCKED.`;
  else if (clears) latchNote = `This lock takes the creator to ${pctFloor(lockedAfter, supply)}% of supply locked (${f(lockedAfter)}), at or above ${thr}, so LATCH_LOCKED turns on.`;
  else latchNote = `Does not clear the ${thr} threshold: after this lock the creator would have ${pctFloor(lockedAfter, supply)}% of supply locked (${f(lockedAfter)}). LATCH_LOCKED stays off. Depositing at least ${f(need, 'up')} (0.5% fee included) would turn it on.`;

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
    minDeposit: { raw: need.toString(), text: f(need, 'up') },
    transfer,
    ignix,
    fresh: v.fresh,
    results,
  });
}
