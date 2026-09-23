// Turns indexed data into the attested bit word, with a human-readable reason per bit (for logs, UI, explain_latch).
import { ATTESTED_MASK, BITS, type BitName } from '@latch/compiler';
import type { Address } from 'viem';
import { BURN_ADDRESSES, IGNIX, RECOGNISED_LOCKERS, THRESHOLDS } from './config.ts';
import type { Launch } from './ignix.ts';
import type { LpInfo } from './lp.ts';

export interface Holdings {
  supply: bigint; // minted minus burned
  circulating: bigint; // held by counted wallets (supply minus curve, LP/pools, lockers, protocol, burn)
  holders: number; // non-zero balances, excluding protocol/LP/burn/lock addresses
  top10: bigint;
  top10Share: number;
  excluded: string[];
}

export function excludedFor(l: Launch, latchLock?: Address): Set<string> {
  return new Set(
    [
      IGNIX.launchpad, IGNIX.v4PoolManager, ...Object.keys(RECOGNISED_LOCKERS), ...BURN_ADDRESSES,
      l.pair, l.dividendTracker, l.taxRouter, l.splitter, l.tokenAddress, latchLock,
    ].filter(Boolean).map((a) => a!.toLowerCase()),
  );
}

export function holdings(balances: Record<string, string> | undefined, excluded: Set<string>): Holdings {
  const entries = Object.entries(balances ?? {}).map(([a, v]) => [a, BigInt(v)] as const);
  const burned = entries.filter(([a]) => BURN_ADDRESSES.includes(a)).reduce((s, [, v]) => s + v, 0n);
  const supply = entries.reduce((s, [, v]) => s + v, 0n) - burned;
  const counted = entries.filter(([a, v]) => v > 0n && !excluded.has(a)).map(([, v]) => v).sort((a, b) => (b > a ? 1 : b < a ? -1 : 0));
  const circulating = counted.reduce((s, v) => s + v, 0n);
  const top10 = counted.slice(0, 10).reduce((s, v) => s + v, 0n);
  // Share of *circulating* supply: unsold curve inventory would otherwise make a dev-only token look distributed.
  const top10Share = circulating > 0n ? Number((top10 * 1_000_000n) / circulating) / 1_000_000 : 1;
  return { supply, circulating, holders: counted.length, top10, top10Share, excluded: [...excluded] };
}

export interface Attestation {
  token: Address;
  creator: Address;
  launchTime: number;
  bits: number;
  reasons: Partial<Record<BitName, string>>;
  data: { holders: number; apiHolders: number; top10Share: number; rev: number | null; lastDevSellBlock: number | null; lp: Omit<LpInfo, 'locked' | 'supply' | 'peak'> & { locked: string; peak: string } | null };
}

export function attest(
  l: Launch,
  h: Holdings,
  lp: LpInfo | undefined,
  lastDevSellBlock: number | undefined,
  head: { number: number; timestamp: number },
): Attestation {
  let bits = 0;
  const reasons: Attestation['reasons'] = {};
  const set = (b: BitName, on: boolean, why: string) => {
    if (on) bits |= 1 << BITS[b];
    reasons[b] = `${on ? '1' : '0'}: ${why}`;
  };
  const rev = l.asp?.rev ?? null;
  set('AGENT_LINKED', l.asp?.matched === 'linked', l.asp ? `OKX.AI agent #${l.asp.id} (${l.asp.matched})` : 'no agent link');
  set('REV_GE_100', (rev ?? 0) >= THRESHOLDS.revLow, rev === null ? 'no agent revenue' : `agent revenue $${rev}`);
  set('REV_GE_1000', (rev ?? 0) >= THRESHOLDS.revHigh, rev === null ? 'no agent revenue' : `agent revenue $${rev}`);
  if (!l.graduated) {
    set('LP_LOCKED', false, 'on bonding curve, no LP yet');
    set('LP_PULLED', false, 'on bonding curve, no LP yet');
  } else if (!lp) {
    set('LP_LOCKED', false, `graduated (${l.venue}) but LP custody unreadable`);
    set('LP_PULLED', false, 'no LP evidence');
  } else {
    set('LP_LOCKED', lp.lpLocked, `${lp.venue} locked=${lp.locked} peak=${lp.peak}${lp.holder ? ` nftOwner=${lp.holder}` : ''}`);
    set('LP_PULLED', lp.lpPulled, lp.lpPulled ? `locked LP fell to ${lp.locked} from peak ${lp.peak}` : 'locked LP at peak');
  }
  const pct = (h.top10Share * 100).toFixed(2);
  set('TOP10_LT_40', h.top10Share < THRESHOLDS.top10Loose, `top-10 wallets hold ${pct}% of circulating supply (excl. curve/LP/lockers/burn)`);
  set('TOP10_LT_25', h.top10Share < THRESHOLDS.top10Strict, `top-10 wallets hold ${pct}% of circulating supply`);
  const windowStart = head.number - THRESHOLDS.devSellWindowSec; // X Layer: 1 block per second
  const sold = lastDevSellBlock !== undefined && lastDevSellBlock >= windowStart;
  set(
    'DEV_NO_SELL_7D',
    !sold,
    lastDevSellBlock === undefined ? 'creator never sent tokens out' : `creator last sent tokens out at block ${lastDevSellBlock}${sold ? ' (within 7d)' : ''}`,
  );
  set('HOLDERS_GE_100', h.holders >= THRESHOLDS.holdersLow, `${h.holders} holders (API: ${l.holders})`);
  set('HOLDERS_GE_300', h.holders >= THRESHOLDS.holdersHigh, `${h.holders} holders`);
  if (bits & ~ATTESTED_MASK) throw new Error(`attested bits outside mask for ${l.tokenAddress}`);

  return {
    token: l.tokenAddress,
    creator: l.creator,
    launchTime: Math.floor(Date.parse(l.createdTime) / 1000),
    bits,
    reasons,
    data: {
      holders: h.holders,
      apiHolders: l.holders,
      top10Share: h.top10Share,
      rev,
      lastDevSellBlock: lastDevSellBlock ?? null,
      lp: lp ? { venue: lp.venue, holder: lp.holder, lpLocked: lp.lpLocked, lpPulled: lp.lpPulled, locked: lp.locked.toString(), peak: lp.peak.toString() } : null,
    },
  };
}
