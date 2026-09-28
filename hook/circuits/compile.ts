// Fee-policy circuits for FeeCircuitHook, compiled with the repo's NAND compiler and verified exhaustively over all
// 2^16 inputs (compile() throws on any mismatch). Writes hook/test/fixtures/fee-circuits.json, which the Solidity
// tests and the tape-out step read. CI regenerates it and fails if it differs from the committed file.
//
//   pnpm --filter @latch/compiler exec tsx ../hook/circuits/compile.ts
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, evalRule, parseRule, type Schema } from '../../compiler/src/index.ts';

/** The hook's 5 fact bits (FeeCircuitHook.sol packs them in this order; bits 5..15 are always 0). */
export const FEE_BITS = {
  VOL_HIGH: 0, // windowed realised volatility >= high threshold
  VOL_ELEVATED: 1, // windowed realised volatility >= elevated threshold
  DEPTH_THIN: 2, // windowed in-range liquidity < thin threshold
  DEPTH_CRITICAL: 3, // windowed in-range liquidity < critical threshold
  DEPTH_DRAIN: 4, // current liquidity < half of the previous epoch's floor (LPs leaving)
} as const satisfies Schema;
const N_FACTS = 5;

/** tier = (VOL_GUARD << 1) | DEPTH_GUARD; fees per tier are fixed in the hook's constructor. */
export const CIRCUITS = {
  // High volatility -> top half of the tier table; elevated volatility counts only when depth is also weak.
  VOL_GUARD: { any: ['VOL_HIGH', { all: ['VOL_ELEVATED', { any: ['DEPTH_THIN', 'DEPTH_DRAIN'] }] }] },
  // Thin, critical or draining depth -> odd tiers.
  DEPTH_GUARD: { any: ['DEPTH_THIN', 'DEPTH_CRITICAL', 'DEPTH_DRAIN'] },
};

const out = Object.entries(CIRCUITS).map(([name, dsl]) => {
  const c = compile(name, dsl, FEE_BITS);
  return { name, infix: c.infix, netlist: c.netlist, netlistHash: c.netlistHash, nandCount: c.nandCount, latchCount: c.latchCount, gateCount: c.gateCount };
});

// Expected tier for every fact word, straight from the DSL (independent of the netlist).
const vol = parseRule(CIRCUITS.VOL_GUARD, '$', FEE_BITS);
const depth = parseRule(CIRCUITS.DEPTH_GUARD, '$', FEE_BITS);
const tiers = Array.from({ length: 1 << N_FACTS }, (_, f) => ((evalRule(vol, f, FEE_BITS) ? 1 : 0) << 1) | (evalRule(depth, f, FEE_BITS) ? 1 : 0));
let table = 0n;
tiers.forEach((t, f) => { table |= BigInt(t) << BigInt(2 * f); });

const file = join(dirname(fileURLToPath(import.meta.url)), '../test/fixtures/fee-circuits.json');
writeFileSync(file, JSON.stringify({ schema: FEE_BITS, nFacts: N_FACTS, circuits: out, tiers, table: `0x${table.toString(16).padStart(16, '0')}` }, null, 2) + '\n');
console.log(out.map((c) => `${c.name}: ${c.gateCount} gates  ${c.infix}`).join('\n'));
console.log('tiers', tiers.join(''));
