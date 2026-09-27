// Pure rules for creating a lock: validation before any wallet prompt, plain-language revert reasons, threshold math
// that matches LatchLock/LatchGate exactly, and token-amount formatting. No React, no network: unit-tested.

export const XLAYER_CHAIN_ID = 196;

export interface TrancheInput { filterId: number; bps: number }
export interface FilterFacts { id: number; name: string; stateful: boolean }

export interface LockDraft {
  connected: boolean;
  chainId: number | undefined;
  tokenValid: boolean;
  symbol: string;
  decimals: number;
  amount: bigint | undefined; // raw units; undefined = unparseable
  balance: bigint | undefined;
  beneficiaryValid: boolean;
  tranches: TrancheInput[];
  filters: FilterFacts[];
  /** Result of simulating a 1-wei transfer of the token from the wallet to LatchLock: undefined = not checked yet. */
  transferable: { ok: true } | { ok: false; reason: string } | undefined;
}

/** Everything that must be true before the approve is even offered. Empty = OK. */
export function blockers(d: LockDraft): string[] {
  const out: string[] = [];
  if (!d.connected) out.push('Connect a wallet.');
  else if (d.chainId !== XLAYER_CHAIN_ID) out.push(`Switch your wallet to X Layer (chain ${XLAYER_CHAIN_ID}); it is on chain ${d.chainId ?? 'unknown'}.`);
  if (!d.tokenValid) out.push('Enter a token address.');
  if (d.amount === undefined) out.push('Enter an amount.');
  else if (d.amount <= 0n) out.push('Amount must be greater than zero.');
  else if (d.balance !== undefined && d.amount > d.balance) out.push(`Amount is more than your balance (${formatAmount(d.balance, d.decimals, d.symbol)}).`);
  if (!d.beneficiaryValid) out.push('Beneficiary is not a valid address.');
  const sum = d.tranches.reduce((s, t) => s + t.bps, 0);
  if (d.tranches.length === 0) out.push('Add at least one tranche.');
  if (sum !== 10_000) out.push(`Tranches sum to ${sum / 100}%, must be 100%.`);
  d.tranches.forEach((t, i) => {
    const f = d.filters.find((x) => x.id === t.filterId);
    if (!t.filterId) out.push(`Tranche ${i + 1} has no unlock circuit selected.`);
    else if (!f) out.push(`Tranche ${i + 1}: filter #${t.filterId} is not registered on LatchGate.`);
    else if (f.stateful) out.push(`Tranche ${i + 1}: ${f.name} is a stateful (latch) filter; LatchLock rejects these as unlock circuits.`);
    if (t.bps <= 0) out.push(`Tranche ${i + 1} has a 0% share; remove it or give it a share.`);
  });
  if (d.tranches.length > 8) out.push('At most 8 tranches.');
  if (d.transferable && !d.transferable.ok) out.push(d.transferable.reason);
  return out;
}

/** Approve state for the amount being locked. */
export function approvalStep(allowance: bigint | undefined, amount: bigint | undefined): 'unknown' | 'needed' | 'reapprove-lower' | 'ok' {
  if (allowance === undefined || amount === undefined) return 'unknown';
  if (allowance < amount) return 'needed';
  if (allowance > amount) return 'reapprove-lower'; // works, but leaves a larger standing approval than this lock needs
  return 'ok';
}

/** Exactly what LatchLock stores for a deposit that arrives in full (fee rounds down, in the depositor's favour). */
export const lockedAfterFee = (received: bigint, feeBps: number) => received - (received * BigInt(feeBps)) / 10_000n;

/** LatchLock.isLocked: still-locked * 10_000 >= supply * minLockBps. */
export const clearsThreshold = (locked: bigint, supply: bigint, minLockBps: number) => supply > 0n && locked * 10_000n >= supply * BigInt(minLockBps);

/**
 * Smallest deposit (fee included) after which the creator's still-locked amount clears minLockBps of supply.
 * Exact: depositing this clears the threshold and depositing one unit less does not (tested exhaustively).
 */
export function minDepositForThreshold(supply: bigint, minLockBps: number, alreadyLocked: bigint, feeBps: number): bigint {
  if (clearsThreshold(alreadyLocked, supply, minLockBps)) return 0n;
  const target = ceilDiv(supply * BigInt(minLockBps), 10_000n) - alreadyLocked; // net locked still needed
  // locked(A) = A - floor(A*fee/10000) is non-decreasing in A; start from the real-valued bound and step to the exact minimum.
  let a = ceilDiv(target * 10_000n, BigInt(10_000 - feeBps));
  while (a > 0n && lockedAfterFee(a - 1n, feeBps) >= target) a--;
  while (lockedAfterFee(a, feeBps) < target) a++;
  return a;
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** "50,251,257 IGGY". `round: 'up'` for minimums (depositing the shown number is always enough). */
export function formatAmount(raw: bigint, decimals: number, symbol?: string, round: 'down' | 'up' = 'down', maxFrac = 2): string {
  const unit = 10n ** BigInt(decimals);
  const step = 10n ** BigInt(Math.max(0, decimals - maxFrac));
  let v = round === 'up' ? ceilDiv(raw, step) * step : (raw / step) * step;
  const whole = v / unit;
  let frac = (v % unit).toString().padStart(decimals, '0').slice(0, maxFrac).replace(/0+$/, '');
  const s = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac ? `.${frac}` : '');
  return symbol ? `${s} ${symbol}` : s;
}

/** Share of supply to 2 decimals, rounded DOWN so a value just under a threshold never displays as meeting it. */
export const pctFloor = (part: bigint, whole: bigint) => (whole > 0n ? Number((part * 10_000n) / whole) / 100 : 0);

/** Plain-language sentences for every custom error the lock path can hit (LatchLock source + token + OZ SafeERC20). */
export function explainRevert(name: string | undefined, args: readonly unknown[] = [], ctx: { symbol?: string; decimals?: number; filters?: FilterFacts[] } = {}): string {
  const sym = ctx.symbol ?? 'the token';
  const amt = (v: unknown) => (typeof v === 'bigint' && ctx.decimals !== undefined ? formatAmount(v, ctx.decimals, ctx.symbol) : String(v));
  const fname = (id: unknown) => ctx.filters?.find((f) => BigInt(f.id) === BigInt(id as bigint))?.name ?? `filter #${String(id)}`;
  switch (name) {
    case 'CurveOnly': return `${sym} is still on its Ignix bonding curve. Ignix tokens cannot be transferred to any wallet or contract until they graduate to a pool, so they cannot be locked yet.`;
    case 'BadTranches': return 'The tranches are invalid: they must be 1 to 8 rows, each with a share above 0%, summing to exactly 100%.';
    case 'UnknownFilter': return `Tranche uses ${fname(args[0])}, which is not a registered filter.`;
    case 'StatefulUnlock': return `${fname(args[0])} is a stateful (latch) filter. LatchLock only accepts stateless unlock circuits.`;
    case 'ZeroAmount': return 'Nothing would be locked: the amount is zero, or the token delivered nothing to LatchLock.';
    case 'ZeroAddress': return 'Token or beneficiary is the zero address.';
    case 'ERC20InsufficientAllowance': return `LatchLock is approved for ${amt(args[1])} but needs ${amt(args[2])}. Approve the full amount first.`;
    case 'ERC20InsufficientBalance': return `Your wallet holds ${amt(args[1])} but the lock needs ${amt(args[2])}.`;
    case 'SafeERC20FailedOperation': return `${sym} refused the transfer (it returned false). This token cannot be locked as is.`;
    case 'ReentrancyGuardReentrantCall': return 'The token tried to re-enter LatchLock during the transfer; the lock was refused.';
    case 'UnknownLock': return 'That lock does not exist.';
    case 'BadTranche': return 'That tranche does not exist on this lock.';
    case 'AlreadyReleased': return 'That tranche has already been released.';
    case 'StillLatched': return 'The unlock circuit does not pass yet, so this tranche cannot be released.';
    case 'FeedStale': return 'The Nandout feed is stale; releases wait until the attestor posts again.';
    default: return name ? `The contract reverted with ${name}.` : 'The transaction would revert for a reason the contract did not name.';
  }
}
