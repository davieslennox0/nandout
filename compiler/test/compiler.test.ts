import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compile, decode, DslError, encode, lower, packBits, parseCircuit, parseRule, step, verify, VerificationError, N_IN, N_OUT,
} from '../src/index.ts';
import { STARTERS } from '../src/starters.ts';

test('all starter circuits compile and verify exhaustively', () => {
  for (const [name, dsl] of Object.entries(STARTERS)) {
    const c = compile(name, dsl);
    assert.equal(c.nState, name.startsWith('STICKY') ? 1 : 0, name);
    assert.ok(c.gateCount > 0 && c.gateCount < 40, `${name}: ${c.gateCount} gates`);
  }
});

test('single-bit rule gets a 2-NAND buffer so the output is a fresh trailing signal', () => {
  const c = compile('ONE', 'LP_LOCKED');
  assert.equal(c.gateCount, 2);
});

test('sticky latch: set holds until reset, reset wins', () => {
  const dsl = { latch: { set: { all: ['LP_LOCKED', 'TOP10_LT_40'] }, reset: { not: 'DEV_NO_SELL_7D' } } };
  const c = compile('STICKY', dsl);
  assert.equal(c.nState, 1);
  const nl = decode(Buffer.from(c.netlist.slice(2), 'hex'), N_IN, N_OUT);
  const LP = 1 << 3, TOP = 1 << 4, NOSELL = 1 << 6;
  let s = 0;
  const run = (x: number) => { const r = step(nl, s, x); s = r.state; return r.outputs & 1; };
  assert.equal(run(NOSELL), 0);             // nothing set yet
  assert.equal(run(LP | TOP | NOSELL), 1);  // set
  assert.equal(run(NOSELL), 1);             // conditions gone, still latched
  assert.equal(run(0), 0);                  // dev sold → reset
  assert.equal(run(NOSELL), 0);             // stays reset
  assert.equal(run(LP | TOP), 0);           // set and reset together → reset wins
});

test('verify rejects a netlist that disagrees with the rule', () => {
  const good = lower(parseCircuit({ all: ['LP_LOCKED', 'AGENT_LINKED'] }));
  const bytes = encode(good);
  assert.throws(() => verify(parseCircuit({ any: ['LP_LOCKED', 'AGENT_LINKED'] }), bytes), VerificationError);
});

test('DSL validation', () => {
  assert.throws(() => parseRule('NOPE'), DslError);
  assert.throws(() => parseRule({ all: [] }), DslError);
  assert.throws(() => parseRule({ all: ['LP_LOCKED'], any: ['LP_LOCKED'] }), DslError);
  assert.throws(() => parseCircuit({ latch: { set: 'LP_LOCKED' } }), DslError);
});

test('decode rejects REF and truncated bytes', () => {
  assert.throws(() => decode(Uint8Array.from([2, ...new Array(29).fill(0)]), 16, 1), /REF/);
  assert.throws(() => decode(Uint8Array.from([0, 0, 0]), 16, 1), /truncated/);
});

test('packBits is little-endian per byte', () => {
  assert.deepEqual([...packBits(0x0102, 16)], [0x02, 0x01]);
  assert.deepEqual([...packBits(1 << 8, 16)], [0x00, 0x01]);
});

test('random rules verify', () => {
  const names = ['AGENT_LINKED', 'REV_GE_100', 'LP_LOCKED', 'TOP10_LT_40', 'LATCH_LOCKED', 'AGE_GE_7D', 'HOLDERS_GE_300'];
  let seed = 42;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const gen = (d: number): unknown => {
    if (d === 0 || rnd(3) === 0) return names[rnd(names.length)];
    const k = rnd(3);
    if (k === 0) return { not: gen(d - 1) };
    const items = Array.from({ length: 1 + rnd(3) }, () => gen(d - 1));
    return k === 1 ? { all: items } : { any: items };
  };
  for (let i = 0; i < 25; i++) compile(`R${i}`, gen(4));
});
