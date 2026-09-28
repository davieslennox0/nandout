// Rebuilds per-token balances and dev-sell times from ERC-20 Transfer logs. Balances are additive, so ranges can be
// fetched in any order and in parallel; the state is persisted and later cycles only fetch new blocks.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Address } from 'viem';
import { BURN_ADDRESSES, RPC } from './config.ts';
import type { Launch } from './ignix.ts';

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export interface IndexState {
  version: 1;
  /** Last fully indexed block for each token (tokens join the index at their own creation block). */
  indexedTo: Record<Address, number>;
  /** token → holder → balance (decimal string, raw units). Zero balances are deleted. */
  balances: Record<Address, Record<Address, string>>;
  /**
   * token → last block where the creator sent tokens out (to anyone except LatchLock or a burn address).
   * Conservative on purpose: v4 sells route through aggregator hops, and moving supply to fresh wallets is the usual
   * prelude to selling, so any outflow counts as a dev sell.
   */
  lastDevSellBlock: Record<Address, number>;
}

export function emptyState(): IndexState {
  return { version: 1, indexedTo: {}, balances: {}, lastDevSellBlock: {} };
}

export function loadState(file: string): IndexState {
  if (!existsSync(file)) return emptyState();
  return JSON.parse(readFileSync(file, 'utf8')) as IndexState;
}

export function saveState(file: string, s: IndexState): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(s));
  renameSync(`${file}.tmp`, file);
}

interface RawLog { address: string; topics: string[]; data: string; blockNumber: string }

let rpcId = 0;
async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30_000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
      signal: ac.signal,
    });
    const text = await r.text();
    let j: { result?: T; error?: { message: string } };
    try { j = JSON.parse(text); } catch { throw new Error(`HTTP ${r.status}: ${text.slice(0, 120)}`); }
    if (j.error) throw new Error(j.error.message);
    return j.result as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function headBlock(url = RPC.read): Promise<{ number: number; timestamp: number }> {
  const b = await rpc<{ number: string; timestamp: string }>(url, 'eth_getBlockByNumber', ['latest', false]);
  return { number: Number(b.number), timestamp: Number(b.timestamp) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getLogsFrom(url: string, addresses: string[], from: number, to: number, retries = 5): Promise<RawLog[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rpc<RawLog[]>(url, 'eth_getLogs', [
        { address: addresses, topics: [TRANSFER], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` },
      ]);
    } catch (e) {
      const msg = String((e as Error).message);
      if (/range|too many|exceed|limit|size/i.test(msg) && to > from) throw Object.assign(new Error(msg), { split: true });
      if (attempt >= retries) throw e;
      await sleep(Number(process.env.LOG_RETRY_MS ?? 500) * 2 ** attempt);
    }
  }
}

let fallbackNotices = 0;

/**
 * Primary log RPC (large ranges). If it keeps failing for reasons other than range size (down, rate-limited, or answering
 * with an HTML page), the same range is fetched from the fallback RPC in `RPC.fallbackRange`-block chunks, so a cycle
 * never stalls on one provider. Exported for tests.
 */
export async function getLogs(addresses: string[], from: number, to: number): Promise<RawLog[]> {
  try {
    return await getLogsFrom(RPC.logs, addresses, from, to);
  } catch (e) {
    if ((e as { split?: boolean }).split) throw e;
    if (fallbackNotices++ < 3) console.error(`log RPC ${RPC.logs} failed (${String((e as Error).message).slice(0, 80)}); using ${RPC.logsFallback} in ${RPC.fallbackRange}-block chunks`);
    const out: RawLog[] = [];
    for (let b = from; b <= to; b += RPC.fallbackRange) {
      out.push(...(await getLogsFrom(RPC.logsFallback, addresses, b, Math.min(to, b + RPC.fallbackRange - 1))));
    }
    return out;
  }
}

export interface IndexProgress { done: number; total: number; logs: number }

/**
 * Brings every launch up to `toBlock`. `blockOf(launch)` gives the first block to index for a token that is new
 * to the state (its creation block).
 */
export async function indexTransfers(
  state: IndexState,
  launches: Launch[],
  toBlock: number,
  blockOf: (l: Launch) => number,
  onProgress?: (p: IndexProgress) => void,
  latchLock?: Address,
): Promise<{ logs: number; requests: number }> {
  const byToken = new Map(launches.map((l) => [l.tokenAddress, l]));
  const notASell = new Set<string>([...BURN_ADDRESSES, ...(latchLock ? [latchLock.toLowerCase()] : [])]);

  // One scan from the earliest block any token still needs, applying each log only if it is past that token's own
  // indexedTo. Tokens join and leave Ignix's capped index at different times, so their indexedTo differ; per-token
  // skipping keeps balances exact (nothing counted twice) without one scan per distinct height. New tokens have no
  // indexedTo and had no transfers before their creation, so everything from their creation onward applies.
  const prevIndexedTo = new Map<string, number>();
  const pending: Address[] = [];
  let from = Infinity;
  for (const l of launches) {
    const upTo = state.indexedTo[l.tokenAddress];
    if (upTo !== undefined) prevIndexedTo.set(l.tokenAddress, upTo);
    if (upTo === undefined) { pending.push(l.tokenAddress); from = Math.min(from, blockOf(l)); }
    else if (upTo < toBlock) { pending.push(l.tokenAddress); from = Math.min(from, upTo + 1); }
  }

  const jobs: { addresses: Address[]; from: number; to: number }[] = [];
  if (pending.length) {
    for (let i = 0; i < pending.length; i += RPC.logAddresses) {
      const batch = pending.slice(i, i + RPC.logAddresses);
      for (let b = from; b <= toBlock; b += RPC.logRange) jobs.push({ addresses: batch, from: b, to: Math.min(toBlock, b + RPC.logRange - 1) });
    }
  }

  let logs = 0, requests = 0, done = 0;
  let total = jobs.length;
  const apply = (l: RawLog) => {
    if (l.topics.length !== 3) return;
    const token = l.address.toLowerCase() as Address;
    const launch = byToken.get(token);
    if (!launch) return;
    const upTo = prevIndexedTo.get(token);
    if (upTo !== undefined && Number(l.blockNumber) <= upTo) return; // already counted in an earlier cycle
    const from = `0x${l.topics[1].slice(26)}` as Address;
    const to = `0x${l.topics[2].slice(26)}` as Address;
    const v = BigInt(l.data === '0x' ? 0 : l.data);
    const bal = (state.balances[token] ??= {});
    if (from !== '0x0000000000000000000000000000000000000000') {
      const nb = BigInt(bal[from] ?? '0') - v;
      if (nb === 0n) delete bal[from]; else bal[from] = nb.toString();
    }
    const nb = BigInt(bal[to] ?? '0') + v;
    if (nb === 0n) delete bal[to]; else bal[to] = nb.toString();
    if (from === launch.creator && !notASell.has(to) && v > 0n) {
      const bn = Number(l.blockNumber);
      if (bn > (state.lastDevSellBlock[token] ?? 0)) state.lastDevSellBlock[token] = bn;
    }
  };

  const queue = [...jobs];
  const worker = async () => {
    while (queue.length) {
      const job = queue.shift()!;
      try {
        const res = await getLogs(job.addresses, job.from, job.to);
        requests++;
        logs += res.length;
        res.forEach(apply);
        done++;
      } catch (e) {
        if ((e as { split?: boolean }).split) {
          total++;
          const mid = Math.floor((job.from + job.to) / 2);
          queue.unshift({ ...job, to: mid }, { ...job, from: mid + 1 });
          continue;
        }
        throw e;
      }
      onProgress?.({ done, total, logs });
    }
  };
  await Promise.all(Array.from({ length: RPC.logConcurrency }, worker));
  for (const l of launches) state.indexedTo[l.tokenAddress] = toBlock;
  return { logs, requests };
}
