import { BITS, type BitName, N_IN, type Schema } from './bits.ts';

/** Rule DSL: a bit name, or {all:[...]}, {any:[...]}, {not: rule}. */
export type Rule = BitName | { all: Rule[] } | { any: Rule[] } | { not: Rule };

/**
 * A circuit is either a combinational rule, or a sticky (stateful) latch:
 * `{"latch": {"set": Rule, "reset": Rule}}`. Reset wins: next = NOT reset AND (set OR previous).
 */
export type Circuit =
  | { kind: 'combinational'; rule: Rule }
  | { kind: 'latch'; set: Rule; reset: Rule };

export class DslError extends Error {}

/** Leaf names are typed as BitName for Latch; with a custom schema they are that schema's names (validated at parse). */
const index = (name: string, schema: Schema): number => schema[name];

export function parseCircuit(input: unknown, schema: Schema = BITS): Circuit {
  if (input !== null && typeof input === 'object' && !Array.isArray(input) && 'latch' in input) {
    if (Object.keys(input).length !== 1) throw new DslError('$: "latch" must be the only key');
    const l = (input as { latch: unknown }).latch;
    if (l === null || typeof l !== 'object' || Array.isArray(l)) throw new DslError('$.latch: expected {set, reset}');
    const keys = Object.keys(l).sort().join(',');
    if (keys !== 'reset,set') throw new DslError('$.latch: expected exactly {set, reset}');
    const { set, reset } = l as { set: unknown; reset: unknown };
    return { kind: 'latch', set: parseRule(set, '$.latch.set', schema), reset: parseRule(reset, '$.latch.reset', schema) };
  }
  return { kind: 'combinational', rule: parseRule(input, '$', schema) };
}

/** Reference semantics for one step of a circuit (state is 0/1; unused for combinational). */
export function evalCircuit(c: Circuit, state: number, inputs: number, schema: Schema = BITS): { state: number; pass: boolean } {
  if (c.kind === 'combinational') return { state: 0, pass: evalRule(c.rule, inputs, schema) };
  const next = !evalRule(c.reset, inputs, schema) && (evalRule(c.set, inputs, schema) || state === 1);
  return { state: next ? 1 : 0, pass: next };
}

export function circuitToJson(c: Circuit): unknown {
  return c.kind === 'combinational' ? c.rule : { latch: { set: c.set, reset: c.reset } };
}

/** Validates untrusted JSON and returns a typed Rule. Throws DslError with a path on failure. */
export function parseRule(input: unknown, path = '$', schema: Schema = BITS): Rule {
  if (typeof input === 'string') {
    const i = Object.prototype.hasOwnProperty.call(schema, input) ? schema[input] : undefined;
    if (i === undefined) throw new DslError(`${path}: unknown bit "${input}"`);
    if (!Number.isInteger(i) || i < 0 || i >= N_IN) throw new DslError(`${path}: bit "${input}" maps to index ${i}, outside 0..${N_IN - 1}`);
    return input as BitName;
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new DslError(`${path}: expected a bit name or an object with all/any/not`);
  }
  const keys = Object.keys(input);
  if (keys.length !== 1) throw new DslError(`${path}: object must have exactly one of all/any/not`);
  const [k] = keys;
  const v = (input as Record<string, unknown>)[k];
  if (k === 'not') return { not: parseRule(v, `${path}.not`) };
  if (k === 'all' || k === 'any') {
    if (!Array.isArray(v) || v.length === 0) throw new DslError(`${path}.${k}: expected a non-empty array`);
    const items = v.map((x, i) => parseRule(x, `${path}.${k}[${i}]`, schema));
    return k === 'all' ? { all: items } : { any: items };
  }
  throw new DslError(`${path}: unknown operator "${k}"`);
}

export function evalRule(rule: Rule, inputs: number, schema: Schema = BITS): boolean {
  if (typeof rule === 'string') return ((inputs >> index(rule, schema)) & 1) === 1;
  if ('not' in rule) return !evalRule(rule.not, inputs, schema);
  if ('all' in rule) return rule.all.every((r) => evalRule(r, inputs, schema));
  return rule.any.some((r) => evalRule(r, inputs, schema));
}

/** Canonical JSON (stable key order is trivial here: single-key objects, arrays keep order). */
export function formatRule(rule: Rule): string {
  return JSON.stringify(rule);
}

/** Human-readable infix form, e.g. `LP_LOCKED AND (A OR B)`. */
export function toInfix(rule: Rule, top = true): string {
  if (typeof rule === 'string') return rule;
  if ('not' in rule) return `NOT ${toInfix(rule.not, false)}`;
  const parts = ('all' in rule ? rule.all : rule.any).map((r) => toInfix(r, false));
  if (parts.length === 1) return parts[0];
  const s = parts.join('all' in rule ? ' AND ' : ' OR ');
  return top ? s : `(${s})`;
}

export function bitsUsed(rule: Rule, acc = new Set<BitName>()): Set<BitName> {
  if (typeof rule === 'string') acc.add(rule);
  else if ('not' in rule) bitsUsed(rule.not, acc);
  else ('all' in rule ? rule.all : rule.any).forEach((r) => bitsUsed(r, acc));
  return acc;
}
