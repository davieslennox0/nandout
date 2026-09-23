// Renders a cycle log (logs/cycle-*.json) as a markdown bit-distribution report.
//   tsx src/report.ts logs/cycle-XXXX.json > ../docs/data/bit-distribution.md
import { readFileSync } from 'node:fs';
import { BITS, type BitName } from '@latch/compiler';
import type { Attestation } from './bits.ts';

const file = process.argv[2];
if (!file) throw new Error('usage: report.ts <cycle.json>');
const { summary: s, attestations, filters } = JSON.parse(readFileSync(file, 'utf8')) as {
  summary: Record<string, any>;
  attestations: Attestation[];
  filters?: Record<string, { filterId: number; stateful: boolean; pass: string[] }>;
};
const names = Object.keys(BITS) as BitName[];
const n = s.launches as number;
const pct = (k: number) => `${((100 * k) / n).toFixed(1)}%`;
const has = (a: Attestation, b: BitName) => (a.bits >> BITS[b]) & 1;
const ONCHAIN = new Set<BitName>(['LATCH_LOCKED', 'AGE_GE_7D', 'AGE_GE_30D']);

const lines: string[] = [];
const out = (x = '') => lines.push(x);
out(`# Bit distribution: first full attestor cycle`);
out();
out(`Block ${s.block} (${s.at}). ${n} Ignix launches, ${s.graduated} graduated, ${s.agentLinked} agent-linked.`);
out(`Read-only against X Layer mainnet; bits posted to a **local fork** LatchFeed (chain id 1960), filters evaluated there.`);
out();
out(`## Per bit`);
out();
out(`| bit | name | source | set | share |`);
out(`|---|---|---|---|---|`);
for (const b of names) {
  const k = ONCHAIN.has(b) ? (b === 'LATCH_LOCKED' ? 0 : s.onchainAge[b]) : s.bitCounts[b];
  out(`| ${BITS[b]} | ${b} | ${ONCHAIN.has(b) ? 'on-chain' : 'attested'} | ${k} | ${pct(k)} |`);
}
out();
out(`Top-10 share of circulating supply: p10 ${s.top10Share.p10}%, median ${s.top10Share.p50}%, p90 ${s.top10Share.p90}%.`);
out(`Holder counts vs Ignix API: ${s.holderCountVsApi.within5}/${n} within ±5 (our count excludes curve, pools, lockers, protocol, burn).`);
out();
out(`## Most common attested bit combinations`);
out();
out(`| launches | bits |`);
out(`|---|---|`);
for (const c of s.topCombos.slice(0, 10)) out(`| ${c.n} | ${c.names || '(none)'} |`);
if (filters) {
  out();
  out(`## Starter filters (evaluated through LatchGate on the fork)`);
  out();
  out(`| filter | kind | pass | share |`);
  out(`|---|---|---|---|`);
  for (const [k, v] of Object.entries(filters)) out(`| ${k} | ${v.stateful ? 'latch' : 'combinational'} | ${v.pass.length} | ${pct(v.pass.length)} |`);
}
const interesting = attestations
  .filter((a) => a.data.lp || has(a, 'AGENT_LINKED') || has(a, 'HOLDERS_GE_100'))
  .sort((a, b) => b.data.holders - a.data.holders);
const passes = (t: string) => Object.entries(filters ?? {}).filter(([, v]) => v.pass.includes(t)).map(([k]) => k).join(', ');
out();
out(`## Launches with any signal (graduated, agent-linked, or ≥100 holders): ${interesting.length}`);
out();
out(`| token | holders | top-10 | LP | dev sold 7d | agent | passes |`);
out(`|---|---|---|---|---|---|---|`);
for (const a of interesting) {
  out(
    `| \`${a.token}\` | ${a.data.holders} | ${(a.data.top10Share * 100).toFixed(1)}% | ${a.data.lp ? (a.data.lp.lpLocked ? `locked (${a.data.lp.venue})` : a.data.lp.lpPulled ? 'PULLED' : 'none') : 'curve'} | ${has(a, 'DEV_NO_SELL_7D') ? '' : 'yes'} | ${a.data.rev !== null ? `$${a.data.rev}` : ''} | ${passes(a.token)} |`,
  );
}
console.log(lines.join('\n'));
