// Spot-checks the indexed balances against on-chain balanceOf at the indexed block. Any mismatch means the log
// backfill dropped or double-counted transfers, and the holder/top-10 bits cannot be trusted.
//   tsx src/verify-index.ts [sampleTokens=60]
import { readFileSync } from 'node:fs';
import { createPublicClient, http, parseAbi, type Address } from 'viem';
import { xLayer } from 'viem/chains';
import { RPC } from './config.ts';
import type { IndexState } from './indexer.ts';

const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
const state = JSON.parse(readFileSync('state/index.json', 'utf8')) as IndexState;
const n = Number(process.argv[2] ?? 60);
const client = createPublicClient({ chain: xLayer, transport: http(RPC.logs), batch: { multicall: { batchSize: 4096 } } });

const tokens = Object.keys(state.balances) as Address[];
let seed = 7;
const pick = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
const sample = Array.from({ length: Math.min(n, tokens.length) }, () => tokens[pick() % tokens.length]);

const checks: { token: Address; holder: Address; want: bigint }[] = [];
for (const t of new Set(sample)) {
  const holders = Object.entries(state.balances[t]).sort((a, b) => (BigInt(b[1]) > BigInt(a[1]) ? 1 : -1));
  // largest 3 and 2 random holders per token
  for (const [h, v] of [...holders.slice(0, 3), ...Array.from({ length: 2 }, () => holders[pick() % holders.length])]) {
    if (h === '0x0000000000000000000000000000000000000000') continue;
    checks.push({ token: t, holder: h as Address, want: BigInt(v) });
  }
}
const block = BigInt(Math.max(...Object.values(state.indexedTo)));
const res = await client.multicall({
  contracts: checks.map((c) => ({ address: c.token, abi: erc20, functionName: 'balanceOf', args: [c.holder] }) as const),
  allowFailure: true,
  blockNumber: block,
});
let bad = 0;
res.forEach((r, i) => {
  if (r.status !== 'success' || r.result !== checks[i].want) {
    bad++;
    if (bad <= 10) console.log('MISMATCH', checks[i].token, checks[i].holder, 'indexed', checks[i].want, 'chain', r.status === 'success' ? r.result : r.error.message.slice(0, 80));
  }
});
console.log(JSON.stringify({ block: Number(block), tokens: new Set(sample).size, checks: checks.length, mismatches: bad }));
process.exit(bad ? 1 : 0);
