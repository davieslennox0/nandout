import { keccak256, toHex } from 'viem';
import { BITS, N_IN, N_OUT, RESERVED_MASK, type Schema } from './bits.ts';
import { type Circuit, circuitToJson, evalCircuit, parseCircuit, toInfix } from './dsl.ts';
import { lower } from './lower.ts';
import { decode, encode, estimateEvalGas, gateCount, type Netlist, nState, step } from './netlist.ts';

export * from './bits.ts';
export * from './dsl.ts';
export * from './netlist.ts';
export { lower } from './lower.ts';
export { STARTERS } from './starters.ts';

export interface Compiled {
  name: string;
  kind: Circuit['kind'];
  dsl: unknown;
  infix: string;
  nIn: number;
  nOut: number;
  nState: number;
  gateCount: number; // = transistors burned (NAND + LATCH)
  nandCount: number;
  latchCount: number;
  netlist: `0x${string}`; // TapeOut tapeout(nl, nIn, nOut) payload
  netlistHash: `0x${string}`; // keccak256(netlist) — pass to LatchGate.registerFilter
  estEvalGas: { tx: number; internalCall: number };
}

export class VerificationError extends Error {}

/**
 * Exhaustively checks the encoded netlist against the DSL: every one of the 2^16 inputs, and for latch
 * circuits every (previous state, input) pair. Reserved bits are included in the sweep so a netlist can
 * never depend on them. Re-decodes the bytes first, so what is verified is exactly what gets taped out.
 */
export function verify(c: Circuit, bytes: Uint8Array, schema: Schema = BITS): void {
  const nl = decode(bytes, N_IN, N_OUT);
  const states = c.kind === 'latch' ? [0, 1] : [0];
  if (nState(nl) !== states.length - 1) throw new VerificationError(`expected ${states.length - 1} latches, got ${nState(nl)}`);
  for (const s of states) {
    for (let x = 0; x < 1 << N_IN; x++) {
      const want = evalCircuit(c, s, x, schema);
      const got = step(nl, s, x);
      if ((got.outputs & 1) !== (want.pass ? 1 : 0) || got.state !== want.state) {
        throw new VerificationError(
          `mismatch at state=${s} inputs=0x${x.toString(16)}${x & RESERVED_MASK ? ' (reserved bits set)' : ''}: ` +
            `netlist out=${got.outputs & 1} state=${got.state}, rule pass=${want.pass} state=${want.state}`,
        );
      }
    }
  }
}

/** Compile + exhaustive verification. `schema` defaults to the Latch bits; other consumers pass their own. */
export function compile(name: string, dsl: unknown, schema: Schema = BITS): Compiled {
  const c = parseCircuit(dsl, schema);
  const nl: Netlist = lower(c, schema);
  const bytes = encode(nl);
  verify(c, bytes, schema);
  const hex = toHex(bytes);
  const latchCount = nState(nl);
  return {
    name,
    kind: c.kind,
    dsl: circuitToJson(c),
    infix: c.kind === 'combinational' ? toInfix(c.rule) : `SET ${toInfix(c.set, false)} / RESET ${toInfix(c.reset, false)}`,
    nIn: N_IN,
    nOut: N_OUT,
    nState: latchCount,
    gateCount: gateCount(nl),
    nandCount: gateCount(nl) - latchCount,
    latchCount,
    netlist: hex,
    netlistHash: keccak256(hex),
    estEvalGas: estimateEvalGas(gateCount(nl)),
  };
}
