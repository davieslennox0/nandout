// Derived lock status shared by the share page, the badge and the OG image, so all three always agree.
import { netlistOf, type FilterView, type LockEntry, type TokenView } from './lockview';
import { explainCircuit, explainNetlist, secondsUntil, type Explained } from './explain';

export function explainFilter(f: FilterView, inputs: number, prev = 0): Explained | null {
  if (f.circuit) return explainCircuit(f.circuit, inputs, prev);
  const nl = netlistOf(f);
  return nl ? explainNetlist(nl, inputs, prev) : null;
}

/** Basis points of total supply, to 2 decimals of a percent. */
export const pctOf = (part: bigint, whole: bigint | null) => (whole && whole > 0n ? Number((part * 10_000n) / whole) / 100 : 0);

export interface TrancheStatus {
  lockId: bigint;
  idx: number;
  filter: FilterView | undefined;
  ex: Explained | null;
  /** Live LatchGate.check for the tranche's filter (the gate uses live TapeOut; release uses LatchEvaluator on the
   *  registered snapshot — same netlist bytes, so they agree). */
  chain: TokenView['checks'][number] | undefined;
  /** Seconds until it can release if only time is missing; 0 if releasable now; null if it depends on other conditions. */
  eta: number | null;
}

export function trancheStatus(v: TokenView, l: LockEntry, idx: number): TrancheStatus {
  const t = l.tranches[idx];
  const filter = v.filters.find((f) => f.id === t.filterId);
  const ex = filter && v.inputs !== null ? explainFilter(filter, v.inputs) : null;
  const chain = v.checks[t.filterId];
  let eta: number | null = null;
  if (!t.released && ex) {
    if (ex.pass && chain && 'pass' in chain && chain.pass) eta = 0;
    else if (!ex.pass && ex.why.length && ex.why.every((r) => r.bit === 'AGE_GE_7D' || r.bit === 'AGE_GE_30D')) {
      eta = Math.max(...ex.why.map((r) => secondsUntil(r.bit, v.launchTime, v.blockTime)));
    }
  }
  return { lockId: l.id, idx, filter, ex, chain, eta };
}

export interface Summary {
  state: 'LOCKED' | 'NOT LOCKED' | 'UNKNOWN TOKEN';
  pct: number; // creator's still-locked share of supply
  thresholdPct: number;
  /** Soonest release among the creator's unreleased tranches: 0 = ready now, n = seconds (time-only), null = unknown. */
  nextUnlock: number | null;
  pendingOnConditions: boolean;
  creatorLocks: LockEntry[];
  otherLocks: LockEntry[];
}

export function summarize(v: TokenView): Summary {
  const thresholdPct = v.minLockBps / 100;
  if (!v.known) return { state: 'UNKNOWN TOKEN', pct: 0, thresholdPct, nextUnlock: null, pendingOnConditions: false, creatorLocks: [], otherLocks: v.locks };
  const isCreator = (l: LockEntry) => v.creator !== null && l.depositor.toLowerCase() === v.creator.toLowerCase();
  const creatorLocks = v.locks.filter(isCreator);
  const otherLocks = v.locks.filter((l) => !isCreator(l));
  const etas = creatorLocks.flatMap((l) => l.tranches.map((t, i) => (t.released ? undefined : trancheStatus(v, l, i).eta)).filter((x) => x !== undefined));
  const known = etas.filter((x): x is number => x !== null);
  return {
    state: v.latchLocked ? 'LOCKED' : 'NOT LOCKED',
    pct: pctOf(v.creatorLocked, v.totalSupply),
    thresholdPct,
    nextUnlock: known.length ? Math.min(...known) : null,
    pendingOnConditions: etas.length > 0 && known.length === 0,
    creatorLocks,
    otherLocks,
  };
}
