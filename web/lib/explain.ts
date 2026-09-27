// Human reasons for a circuit's result on a given 16-bit input word. Pass/fail is never shown without these.
import { BITS, step, type BitName, type Circuit, type Netlist, type Rule } from '@latch/compiler';
import { BIT_LABELS, isOnchain } from './bits';

export const has = (bits: number, b: BitName) => ((bits >> BITS[b]) & 1) === 1;

export interface Reason {
  text: string;
  /** Bit this reason hinges on, so the UI can attach a countdown to age bits. */
  bit?: BitName;
}

/** Plain wording for a condition being false. */
const NOT_LABELS: Partial<Record<BitName, string>> = {
  DEV_NO_SELL_7D: 'Dev sent tokens out in the last 7 days',
  LP_PULLED: 'LP has never been pulled',
  LP_LOCKED: 'LP not locked',
  AGENT_LINKED: 'Not linked to an OKX.AI agent',
  LATCH_LOCKED: 'Creator allocation not in LatchLock',
};
const bitText = (b: BitName, want: boolean) => (want ? BIT_LABELS[b] : NOT_LABELS[b] ?? `NOT ${BIT_LABELS[b]}`);

function evalRule(r: Rule, bits: number): boolean {
  if (typeof r === 'string') return has(bits, r);
  if ('not' in r) return !evalRule(r.not, bits);
  return 'all' in r ? r.all.every((x) => evalRule(x, bits)) : r.any.some((x) => evalRule(x, bits));
}

/** Conditions that are not met (for a failing rule) — the smallest honest list: failing AND-terms, or the whole OR. */
function unmet(r: Rule, bits: number): Reason[] {
  if (evalRule(r, bits)) return [];
  if (typeof r === 'string') return [{ text: bitText(r, true), bit: r }];
  if ('not' in r) return typeof r.not === 'string' ? [{ text: bitText(r.not, false), bit: r.not }] : [{ text: `must not hold: ${describe(r.not)}` }];
  if ('all' in r) return r.all.flatMap((x) => unmet(x, bits));
  const alts = r.any.map(describe);
  const bit = r.any.find((x): x is BitName => typeof x === 'string' && (x === 'AGE_GE_7D' || x === 'AGE_GE_30D'));
  return [{ text: `one of: ${alts.join(' · ')}`, bit }];
}

function describe(r: Rule): string {
  if (typeof r === 'string') return BIT_LABELS[r];
  if ('not' in r) return typeof r.not === 'string' ? bitText(r.not, false) : `not (${describe(r.not)})`;
  return ('all' in r ? r.all : r.any).map(describe).join('all' in r ? ' and ' : ' or ');
}

/** Conditions that are met, for a passing rule (what it passed on). */
function met(r: Rule, bits: number): string[] {
  if (typeof r === 'string') return has(bits, r) ? [BIT_LABELS[r]] : [];
  if ('not' in r) return typeof r.not === 'string' && !has(bits, r.not) ? [bitText(r.not, false)] : [];
  if ('all' in r) return r.all.flatMap((x) => met(x, bits));
  const first = r.any.find((x) => evalRule(x, bits));
  return first ? met(first, bits) : [];
}

export interface Explained {
  /** What the reference rule says; compare with the chain result and flag disagreement. */
  pass: boolean;
  why: Reason[];
  kind: 'unmet' | 'met' | 'reset' | 'held' | 'netlist';
}

/**
 * Explain a known (DSL) circuit. For latch circuits `prevState` is the stored slot state; LatchGate.check evaluates
 * the live TapeOut circuit from it.
 */
export function explainCircuit(c: Circuit, bits: number, prevState = 0): Explained {
  if (c.kind === 'combinational') {
    const pass = evalRule(c.rule, bits);
    return pass ? { pass, kind: 'met', why: met(c.rule, bits).map((text) => ({ text })) } : { pass, kind: 'unmet', why: unmet(c.rule, bits) };
  }
  const reset = evalRule(c.reset, bits);
  const set = evalRule(c.set, bits);
  if (reset) return { pass: false, kind: 'reset', why: met(c.reset, bits).map((text) => ({ text: `reset: ${text}` })) };
  if (set) return { pass: true, kind: 'met', why: met(c.set, bits).map((text) => ({ text })) };
  if (prevState === 1) return { pass: true, kind: 'held', why: [{ text: 'holding: set earlier, nothing has reset it since' }] };
  return { pass: false, kind: 'unmet', why: unmet(c.set, bits) };
}

/** Third-party netlist with no DSL: report which single input changes would flip the result. */
export function explainNetlist(nl: Netlist, bits: number, prevState = 0): Explained {
  const pass = (step(nl, prevState, bits).outputs & 1) === 1;
  const why: Reason[] = [];
  for (const [b, i] of Object.entries(BITS) as [BitName, number][]) {
    if (b === 'LP_PULLED' && !has(bits, b)) continue; // monotonic; never becomes set in a holder's favour
    const flipped = (step(nl, prevState, bits ^ (1 << i)).outputs & 1) === 1;
    if (flipped !== pass) why.push({ text: `${pass ? 'would fail if' : 'would pass if'} ${has(bits, b) ? 'not' : ''} ${BIT_LABELS[b]}`.replace('  ', ' '), bit: b });
  }
  if (!why.length) why.push({ text: pass ? 'no single condition change would make it fail' : 'no single condition change would make it pass' });
  return { pass, why, kind: 'netlist' };
}

/** Seconds until an age bit turns on (0 if already on or not an age bit). */
export function secondsUntil(b: BitName | undefined, launchTime: number, now: number): number {
  if (b === 'AGE_GE_7D') return Math.max(0, launchTime + 7 * 86400 - now);
  if (b === 'AGE_GE_30D') return Math.max(0, launchTime + 30 * 86400 - now);
  return 0;
}

export function fmtDuration(s: number): string {
  if (s <= 0) return 'now';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

export { isOnchain };
