#!/usr/bin/env -S npx tsx
import { readFileSync, writeFileSync } from 'node:fs';
import { ATTESTED_MASK, BITS, compile, ONCHAIN_MASK } from './index.ts';
import { STARTERS } from './starters.ts';

const usage = `usage:
  latch-compile starters [--out file.json]      compile + verify all starter circuits
  latch-compile rule '<json>' [--name NAME]     compile + verify one rule (or @file.json)`;

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const [cmd, input] = process.argv.slice(2);
if (cmd === 'starters') {
  const circuits = Object.entries(STARTERS).map(([name, dsl]) => compile(name, dsl));
  for (const c of circuits) console.error(`${c.name.padEnd(16)} ${String(c.gateCount).padStart(3)} gates  ~${c.estEvalGas.internalCall} gas  ${c.infix}`);
  const out = JSON.stringify({ bits: BITS, attestedMask: ATTESTED_MASK, onchainMask: ONCHAIN_MASK, circuits }, null, 2) + '\n';
  const file = arg('--out');
  if (file) writeFileSync(file, out); else process.stdout.write(out);
} else if (cmd === 'rule' && input) {
  const json = JSON.parse(input.startsWith('@') ? readFileSync(input.slice(1), 'utf8') : input);
  process.stdout.write(JSON.stringify(compile(arg('--name') ?? 'CUSTOM', json), null, 2) + '\n');
} else {
  console.error(usage);
  process.exit(1);
}
