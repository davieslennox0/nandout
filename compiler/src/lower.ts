import { BITS, N_IN, N_OUT } from './bits.ts';
import type { Circuit, Rule } from './dsl.ts';
import type { Element, Netlist } from './netlist.ts';

// Direct DSL → NAND lowering. Each sub-expression is kept as (signal, negated?) so NOTs are only
// materialised when a consumer needs the other polarity. NAND(a,b) is structurally hashed (commutative),
// then dead elements are removed. After dead-element removal the output is always the last signal.

interface Lit { s: number; neg: boolean }

class Builder {
  readonly elements: Element[] = [];
  private readonly cache = new Map<string, number>();
  constructor(readonly nIn: number) {}

  private push(e: Element): number {
    this.elements.push(e);
    return 2 + this.nIn + this.elements.length - 1;
  }

  nand(a: number, b: number): number {
    if (a > b) [a, b] = [b, a];
    const key = `${a},${b}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const s = this.push({ op: 'nand', a, b });
    this.cache.set(key, s);
    return s;
  }

  /** Allocates a latch whose d is wired later (feedback). */
  latch(): { q: number; setD: (d: number) => void } {
    const e: Element = { op: 'latch', d: 0 };
    const q = this.push(e);
    return { q, setD: (d) => { e.d = d; } };
  }

  not(s: number): number { return this.nand(s, s); }
  pos(l: Lit): number { return l.neg ? this.not(l.s) : l.s; }
  negated(l: Lit): number { return l.neg ? l.s : this.not(l.s); }

  gen(r: Rule): Lit {
    if (typeof r === 'string') return { s: 2 + BITS[r], neg: false };
    if ('not' in r) { const l = this.gen(r.not); return { s: l.s, neg: !l.neg }; }
    if ('all' in r) {
      // AND(x, y) = NOT NAND(x, y): keep the NAND and mark the result negated.
      return r.all.map((x) => this.gen(x)).reduce((acc, x) => ({ s: this.nand(this.pos(acc), this.pos(x)), neg: true }));
    }
    // OR(x, y) = NAND(NOT x, NOT y)
    return r.any.map((x) => this.gen(x)).reduce((acc, x) => ({ s: this.nand(this.negated(acc), this.negated(x)), neg: false }));
  }

  and(a: Lit, b: Lit): Lit { return { s: this.nand(this.pos(a), this.pos(b)), neg: true }; }
  or(a: Lit, b: Lit): Lit { return { s: this.nand(this.negated(a), this.negated(b)), neg: false }; }
}

function removeDead(elements: Element[], nIn: number, out: number): { elements: Element[]; out: number } {
  const first = 2 + nIn;
  const live = new Set<number>();
  const stack = [out];
  while (stack.length) {
    const s = stack.pop()!;
    if (s < first || live.has(s)) continue;
    live.add(s);
    const e = elements[s - first];
    if (e.op === 'nand') stack.push(e.a, e.b); else stack.push(e.d);
  }
  const remap = new Map<number, number>();
  elements.forEach((_, i) => { if (live.has(first + i)) remap.set(first + i, first + remap.size); });
  const m = (s: number) => (s < first ? s : remap.get(s)!);
  const kept = elements
    .filter((_, i) => live.has(first + i))
    .map((e): Element => (e.op === 'nand' ? { op: 'nand', a: m(e.a), b: m(e.b) } : { op: 'latch', d: m(e.d) }));
  return { elements: kept, out: m(out) };
}

export function lower(c: Circuit): Netlist {
  const b = new Builder(N_IN);
  let out: number;
  if (c.kind === 'combinational') {
    out = b.pos(b.gen(c.rule));
  } else {
    // Reset-priority SR latch: next = NOT reset AND (set OR q). Output = next, so a step reflects this
    // step's inputs; the stored state is what the following step starts from.
    const q = b.latch();
    const next = b.and({ s: b.pos(b.gen(c.reset)), neg: true }, b.or(b.gen(c.set), { s: q.q, neg: false }));
    out = b.pos(next);
    q.setD(out);
  }
  let elements = b.elements;
  if (out < 2 + N_IN) {
    // Output is a bare input/constant: TapeOut needs it as a fresh trailing signal, so buffer it (2 NANDs).
    const t = 2 + N_IN + elements.length;
    elements = [...elements, { op: 'nand', a: out, b: out }, { op: 'nand', a: t, b: t }];
    out = t + 1;
  }
  const r = removeDead(elements, N_IN, out);
  if (r.out !== 2 + N_IN + r.elements.length - 1) throw new Error('internal: output is not the last signal');
  return { nIn: N_IN, nOut: N_OUT, elements: r.elements };
}
