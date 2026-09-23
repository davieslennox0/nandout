// TapeOut netlist format (see docs/RECON.md §1.3 and contracts/src/vendor/tapeout/lib/NetlistVM.sol).
// Signals: 0 = const 0, 1 = const 1, 2..2+nIn-1 = inputs, then one new signal per NAND/LATCH.
// Outputs = the last nOut signals. Multi-byte ints are big-endian; pin/state bits are packed little-endian.
// NAND inputs must be earlier signals; a LATCH's d may point forward (feedback). A LATCH outputs the
// state from the previous step; its new state is d as computed in this step. REF is rejected: Latch
// circuits must be self-contained so the snapshotted copy evaluates identically forever.

export const OP_NAND = 0x00;
export const OP_LATCH = 0x01;
export const OP_REF = 0x02;

export type Element = { op: 'nand'; a: number; b: number } | { op: 'latch'; d: number };

export interface Netlist {
  nIn: number;
  nOut: number;
  elements: Element[]; // element i produces signal 2 + nIn + i
}

const MAX_U24 = 0xffffff;

function u24(out: number[], v: number) {
  if (!Number.isInteger(v) || v < 0 || v > MAX_U24) throw new Error(`signal ${v} out of u24 range`);
  out.push((v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
}

export function nState(nl: Netlist): number {
  return nl.elements.filter((e) => e.op === 'latch').length;
}

export function gateCount(nl: Netlist): number {
  return nl.elements.length;
}

export function encode(nl: Netlist): Uint8Array {
  const out: number[] = [];
  const total = 2 + nl.nIn + nl.elements.length;
  nl.elements.forEach((e, i) => {
    const self = 2 + nl.nIn + i;
    if (e.op === 'nand') {
      if (e.a >= self || e.b >= self) throw new Error(`NAND@${self}: references a future signal`);
      out.push(OP_NAND); u24(out, e.a); u24(out, e.b);
    } else {
      if (e.d >= total) throw new Error(`LATCH@${self}: d out of range`);
      out.push(OP_LATCH); u24(out, e.d);
    }
  });
  return Uint8Array.from(out);
}

/** Decodes a NAND/LATCH netlist. Throws on REF or malformed bytes. */
export function decode(bytes: Uint8Array, nIn: number, nOut: number): Netlist {
  const elements: Element[] = [];
  const rd = (p: number) => (bytes[p] << 16) | (bytes[p + 1] << 8) | bytes[p + 2];
  let p = 0;
  while (p < bytes.length) {
    const op = bytes[p];
    const self = 2 + nIn + elements.length;
    if (op === OP_NAND) {
      if (p + 7 > bytes.length) throw new Error('truncated NAND');
      const a = rd(p + 1), b = rd(p + 4);
      if (a >= self || b >= self) throw new Error(`NAND@${self}: future signal`);
      elements.push({ op: 'nand', a, b });
      p += 7;
    } else if (op === OP_LATCH) {
      if (p + 4 > bytes.length) throw new Error('truncated LATCH');
      elements.push({ op: 'latch', d: rd(p + 1) });
      p += 4;
    } else if (op === OP_REF) {
      throw new Error(`REF at byte ${p}: Latch circuits must be self-contained`);
    } else {
      throw new Error(`unknown opcode 0x${op.toString(16)} at byte ${p}`);
    }
  }
  const total = 2 + nIn + elements.length;
  if (total < 2 + nIn + nOut) throw new Error('too few signals for outputs');
  for (const e of elements) if (e.op === 'latch' && e.d >= total) throw new Error('LATCH d out of range');
  return { nIn, nOut, elements };
}

/**
 * One step, same semantics as NetlistVM.run: latches output `state` (bit k = k-th latch in order),
 * everything else is evaluated in order, then each latch's new state = its d.
 */
export function step(nl: Netlist, state: number, inputs: number): { state: number; outputs: number } {
  const sig = new Uint8Array(2 + nl.nIn + nl.elements.length);
  sig[1] = 1;
  for (let i = 0; i < nl.nIn; i++) sig[2 + i] = (inputs >>> i) & 1;
  const latchD: number[] = [];
  let s = 2 + nl.nIn;
  for (const e of nl.elements) {
    if (e.op === 'nand') sig[s] = sig[e.a] & sig[e.b] ? 0 : 1;
    else { sig[s] = (state >>> latchD.length) & 1; latchD.push(e.d); }
    s++;
  }
  let next = 0;
  latchD.forEach((d, k) => { next |= sig[d] << k; });
  let outputs = 0;
  for (let i = 0; i < nl.nOut; i++) outputs |= sig[sig.length - nl.nOut + i] << i;
  return { state: next, outputs };
}

export function simulate(nl: Netlist, inputs: number): number {
  return step(nl, 0, inputs).outputs;
}

/** Packs a word into TapeOut's little-endian pin bytes (pin i = byte i>>3, bit i&7). */
export function packBits(value: number, n: number): Uint8Array {
  const out = new Uint8Array(Math.ceil(n / 8));
  for (let i = 0; i < n; i++) if ((value >>> i) & 1) out[i >> 3] |= 1 << (i & 7);
  return out;
}

/**
 * Rough eval gas, fitted to eth_estimateGas on live X Layer circuits
 * (51 gates → 167,756; 444 → 1,087,780; 1,500 → 3,476,327). `tx` includes the 21k base cost.
 */
export function estimateEvalGas(gates: number): { tx: number; internalCall: number } {
  const tx = 51_000 + 2_300 * gates;
  return { tx, internalCall: tx - 21_000 };
}
