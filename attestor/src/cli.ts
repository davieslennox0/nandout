// One attestor cycle: Ignix index + X Layer logs/state → attested bits → (optionally) LatchFeed + filter results.
//
//   tsx src/cli.ts                                   compute only (read-only), write logs/cycle-*.json
//   tsx src/cli.ts --feed-rpc http://127.0.0.1:8545 --deployment ../contracts/deployments/1960.json
//                                                    also post to a (fork) LatchFeed and evaluate every filter
// Attestor key comes from ATTESTOR_PRIVATE_KEY. Never point --feed-rpc at mainnet without an explicit go.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { BITS, type BitName } from '@latch/compiler';
import type { Address, Hex } from 'viem';
import { attest, excludedFor, holdings, type Attestation } from './bits.ts';
import { clients, diffAgainstFeed, evaluateFilters, postChanged, type Deployment } from './feed.ts';
import { fetchLaunches } from './ignix.ts';
import { headBlock, indexTransfers, loadState, saveState } from './indexer.ts';
import { readLp, type LpState } from './lp.ts';
import { launchesForCycle, loadRegistry, mergeIndex, recordAttestations, refreshFromApi, saveRegistry, selectRefresh } from './registry.ts';
import { createPublicClient, http as viemHttp, parseAbi } from 'viem';
import { xLayer } from 'viem/chains';
import { RPC } from './config.ts';

const arg = (f: string) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined; };
const STATE = 'state/index.json';
const LP_STATE = 'state/lp.json';
const REGISTRY = 'state/registry.json';
const REFRESH_BUDGET = Number(process.env.REFRESH_BUDGET ?? 120); // out-of-index API refreshes per cycle
const lockAbi = parseAbi([
  'function lockCount() view returns (uint256)',
  'function getLock(uint256) view returns ((address token, address depositor, address beneficiary, uint64 createdAt, uint256 amount, uint256 released), (uint64 filterId, uint16 bps, bool released, uint256 amount)[])',
]);

/** Tokens backing a lock with anything still locked. These always get refreshed. */
async function lockedTokens(lock?: Address): Promise<Set<string>> {
  if (!lock) return new Set();
  const c = createPublicClient({ chain: xLayer, transport: viemHttp(RPC.read), batch: { multicall: { batchSize: 2048 } } });
  const n = Number(await c.readContract({ address: lock, abi: lockAbi, functionName: 'lockCount' }));
  const res = await c.multicall({ contracts: Array.from({ length: n }, (_, i) => ({ address: lock, abi: lockAbi, functionName: 'getLock', args: [BigInt(i + 1)] }) as const), allowFailure: true });
  const out = new Set<string>();
  for (const r of res) if (r.status === 'success' && r.result[0].amount > r.result[0].released) out.add(r.result[0].token.toLowerCase());
  return out;
}
const CONFIRMATIONS = 12;
const log = (...a: unknown[]) => console.error(new Date().toISOString().slice(11, 19), ...a);

async function main() {
  const t0 = Date.now();
  const head = await headBlock();
  const target = head.number - CONFIRMATIONS;
  const index = await fetchLaunches();
  const deployment: Deployment | undefined = arg('--deployment') ? JSON.parse(readFileSync(arg('--deployment')!, 'utf8')) : undefined;
  const state = loadState(STATE);

  // Registry: the index is capped at the newest 5,000, so keep every launch ever seen and refresh the rest ourselves.
  const now = Math.floor(Date.now() / 1000);
  const registry = loadRegistry(REGISTRY);
  mergeIndex(registry, index, now, Object.keys(state.indexedTo));
  const locked = await lockedTokens(deployment?.lock);
  const toRefresh = selectRefresh(registry, locked, now, REFRESH_BUDGET);
  const refreshed = await refreshFromApi(registry, toRefresh, now);
  const launches = launchesForCycle(registry);
  const outside = Object.values(registry.entries).filter((e) => !e.inIndex);
  log(`head ${head.number}, index ${index.length}, registry ${Object.keys(registry.entries).length} (${outside.length} outside index), `
    + `api-refreshed ${refreshed.ok}/${toRefresh.length} (${refreshed.failed} failed), locked tokens ${locked.size}`);
  const blockOf = (l: { createdTime: string }) => head.number - (head.timestamp - Math.floor(Date.parse(l.createdTime) / 1000)) - 600;
  let last = 0;
  const idx = await indexTransfers(state, launches, target, blockOf, (p) => {
    if (Date.now() - last > 10_000) { last = Date.now(); log(`logs ${p.done}/${p.total} requests, ${p.logs} transfers`); }
  }, deployment?.lock);
  saveState(STATE, state);
  log(`indexed ${idx.logs} transfers in ${idx.requests} requests`);

  const lpState: LpState = (() => { try { return JSON.parse(readFileSync(LP_STATE, 'utf8')); } catch { return { peak: {} }; } })();
  const lp = await readLp(launches, lpState);
  writeFileSync(LP_STATE, JSON.stringify(lpState));

  const atts: Attestation[] = launches.map((l) =>
    attest(l, holdings(state.balances[l.tokenAddress], excludedFor(l, deployment?.lock)), lp.get(l.tokenAddress), state.lastDevSellBlock[l.tokenAddress], { number: target, timestamp: head.timestamp }),
  );
  recordAttestations(registry, atts.map((a) => ({ token: a.token, bits: a.bits })), now);
  saveRegistry(REGISTRY, registry);
  writePublic(registry, target, now);

  // Distribution
  const names = Object.keys(BITS) as BitName[];
  const dist = Object.fromEntries(names.map((b) => [b, atts.filter((a) => a.bits & (1 << BITS[b])).length]));
  const combos = new Map<number, number>();
  atts.forEach((a) => combos.set(a.bits, (combos.get(a.bits) ?? 0) + 1));
  const topCombos = [...combos.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([bits, n]) => ({
    n, bits, names: names.filter((b) => bits & (1 << BITS[b])).join(' '),
  }));
  const holderDelta = atts.map((a) => a.data.holders - a.data.apiHolders);
  const summary = {
    at: new Date().toISOString(),
    block: target,
    launches: launches.length,
    inIndex: index.length,
    outsideIndex: outside.length,
    outsideNeverFetched: outside.filter((e) => !e.launch).length,
    apiRefreshed: refreshed,
    graduated: launches.filter((l) => l.graduated).length,
    agentLinked: launches.filter((l) => l.asp).length,
    bitCounts: dist,
    topCombos,
    // On-chain bits (computed by LatchGate, not attested); shown here from launch time for the distribution.
    onchainAge: {
      AGE_GE_7D: atts.filter((a) => head.timestamp - a.launchTime >= 7 * 86400).length,
      AGE_GE_30D: atts.filter((a) => head.timestamp - a.launchTime >= 30 * 86400).length,
    },
    top10Share: (() => {
      const s = atts.map((a) => a.data.top10Share).sort((x, y) => x - y);
      const q = (p: number) => Math.round(s[Math.floor(p * (s.length - 1))] * 1000) / 10;
      return { p10: q(0.1), p50: q(0.5), p90: q(0.9), under40: s.filter((x) => x < 0.4).length, under25: s.filter((x) => x < 0.25).length };
    })(),
    holderCountVsApi: { exact: holderDelta.filter((d) => d === 0).length, within5: holderDelta.filter((d) => Math.abs(d) <= 5).length },
  };

  let filters: Awaited<ReturnType<typeof evaluateFilters>> | undefined;
  if (arg('--feed-rpc') && deployment) {
    const c = clients(arg('--feed-rpc')!, process.env.ATTESTOR_PRIVATE_KEY as Hex | undefined);
    const changed = await diffAgainstFeed(c.pub, deployment.feed, atts);
    const hashes = await postChanged(c, deployment.feed, changed);
    log(`posted ${changed.length} changed tokens in ${hashes.length} txs`);
    filters = await evaluateFilters(c, deployment, atts.map((a) => a.token));
  }

  mkdirSync('logs', { recursive: true });
  const stamp = summary.at.replace(/[:.]/g, '-');
  writeFileSync(`logs/cycle-${stamp}.json`, JSON.stringify({ summary, attestations: atts, filters }, null, 1));
  const byToken = new Map(launches.map((l) => [l.tokenAddress, l]));
  const filterSummary = filters && Object.fromEntries(Object.entries(filters).map(([k, v]) => [k, {
    pass: v.pass.length,
    stateful: v.stateful,
    examples: v.pass.slice(0, 5).map((t) => `${byToken.get(t)?.symbol} ${t}`),
  }]));
  console.log(JSON.stringify({ ...summary, filters: filterSummary, seconds: Math.round((Date.now() - t0) / 1000) }, null, 2));
}

/**
 * Per-token freshness for the site (read server-side by the web app from ATTEST_PUBLIC_DIR). Every registered launch is
 * attested each cycle; launches outside Ignix's index also carry when their API-only fields were last refreshed.
 */
function writePublic(r: ReturnType<typeof loadRegistry>, block: number, now: number) {
  const dir = process.env.ATTEST_PUBLIC_DIR;
  if (!dir) return;
  const outside = Object.entries(r.entries).filter(([, e]) => !e.inIndex && e.launch).map(([t, e]) => {
    const l = e.launch!;
    return { t, s: l.symbol, n: l.name, h: l.holders, g: l.graduated, v: l.venue, a: l.asp?.id ?? null, r: l.asp?.rev ?? null, i: l.image ?? null, api: e.apiRefreshedAt, err: e.apiError, att: e.lastAttestedAt };
  });
  const unfetched = Object.values(r.entries).filter((e) => !e.inIndex && !e.launch).length;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/registry.json.tmp`, JSON.stringify({ generatedAt: new Date(now * 1000).toISOString(), block, cycleAt: now, registered: Object.keys(r.entries).length, unfetched, outside }));
  renameSync(`${dir}/registry.json.tmp`, `${dir}/registry.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });

export type { Address };
