// Nandout agent tools. Read-only by construction: no wallet, no signing, no trading code anywhere in this package.
import { BITS, ONCHAIN_BITS, type BitName } from '@latch/compiler';
import { createPublicClient, http, isAddress, parseAbi, type Address, type PublicClient } from 'viem';
import { xLayer } from 'viem/chains';

export const gateAbi = parseAbi([
  'function filterCount() view returns (uint256)',
  'function getFilter(uint256) view returns ((address cpu, uint64 circuitId, uint32 gateCount, uint32 nState, address netlistPointer, bytes32 netlistHash, address registrant, string name))',
  'function check(address token, uint256 filterId) view returns (bool pass, uint16 inputs)',
  'function checkMany(address[] tokens, uint256 filterId) view returns (bool[] passes, uint16[] ins)',
  'function inputs(address token) view returns (uint16)',
]);
const lockAbi = parseAbi(['function feeBps() view returns (uint16)', 'function minLockBps() view returns (uint16)', 'function locksByToken(address) view returns (uint256[])']);
const feedAbi = parseAbi(['function isFresh() view returns (bool)', 'function lastHeartbeat() view returns (uint64)']);

export interface Env {
  gate?: Address;
  lock?: Address;
  feed?: Address;
  ignixApi: string;
  client: PublicClient;
}

export function envFromProcess(): Env {
  const a = (k: string) => (process.env[k] && isAddress(process.env[k]!) ? (process.env[k] as Address) : undefined);
  return {
    gate: a('LATCH_GATE'),
    lock: a('LATCH_LOCK'),
    feed: a('LATCH_FEED'),
    ignixApi: process.env.IGNIX_API_URL ?? 'https://api.ignix.bot',
    client: createPublicClient({ chain: xLayer, transport: http(process.env.XLAYER_RPC_URL ?? 'https://rpc.xlayer.tech') }) as PublicClient,
  };
}

const NOT_DEPLOYED = 'Nandout contracts are not deployed on X Layer yet, so there is no on-chain answer to give.';

export const REASONS: Record<BitName, [on: string, off: string]> = {
  AGENT_LINKED: ['linked to an OKX.AI agent', 'not linked to any OKX.AI agent'],
  REV_GT_0: ['the linked agent has recorded revenue', 'no recorded agent revenue'],
  REV_GE_10: ['agent revenue is at least $10', 'agent revenue is below $10'],
  LP_LOCKED: ['liquidity is locked in a recognised locker', 'no locked liquidity (still on the bonding curve, or not locked)'],
  TOP10_LT_40: ['the top 10 wallets hold under 40% of circulating supply', 'the top 10 wallets hold 40% or more of circulating supply'],
  TOP10_LT_25: ['the top 10 wallets hold under 25% of circulating supply', 'the top 10 wallets hold 25% or more of circulating supply'],
  DEV_NO_SELL_7D: ['the creator moved no tokens out in the last 7 days', 'the creator moved tokens out in the last 7 days'],
  LATCH_LOCKED: ['the creator keeps an allocation locked in LatchLock', 'the creator has not locked an allocation in LatchLock'],
  AGE_GE_7D: ['older than 7 days', 'younger than 7 days'],
  AGE_GE_30D: ['older than 30 days', 'younger than 30 days'],
  HOLDERS_GE_100: ['at least 100 holders', 'fewer than 100 holders'],
  HOLDERS_GE_300: ['at least 300 holders', 'fewer than 300 holders'],
  LP_PULLED: ['LIQUIDITY WAS PULLED (permanent flag)', 'liquidity has not been pulled'],
};

/** Human-readable reasons for a 16-bit input word. Pure; exported for tests. */
export function explainBits(word: number): { bit: BitName; value: 0 | 1; source: 'attested' | 'on-chain'; reason: string }[] {
  return (Object.keys(BITS) as BitName[]).map((b) => {
    const v = ((word >> BITS[b]) & 1) as 0 | 1;
    return { bit: b, value: v, source: (ONCHAIN_BITS as readonly string[]).includes(b) ? 'on-chain' : 'attested', reason: REASONS[b][v ? 0 : 1] };
  });
}

async function filters(env: Env) {
  const n = Number(await env.client.readContract({ address: env.gate!, abi: gateAbi, functionName: 'filterCount' }));
  const out: { id: number; name: string; stateful: boolean; gates: number }[] = [];
  for (let i = 1; i <= n; i++) {
    const f = await env.client.readContract({ address: env.gate!, abi: gateAbi, functionName: 'getFilter', args: [BigInt(i)] });
    out.push({ id: i, name: f.name, stateful: f.nState > 0, gates: f.gateCount });
  }
  return out;
}

async function resolveFilter(env: Env, filter: string | number) {
  const all = await filters(env);
  const f = typeof filter === 'number' || /^\d+$/.test(String(filter))
    ? all.find((x) => x.id === Number(filter))
    : all.find((x) => x.name.toLowerCase() === String(filter).toLowerCase());
  if (!f) throw new Error(`Unknown filter "${filter}". Registered: ${all.map((x) => `#${x.id} ${x.name}`).join(', ')}`);
  return f;
}

export async function checkToken(env: Env, token: string, filter: string | number) {
  if (!isAddress(token)) throw new Error('token must be a 0x address');
  if (!env.gate) return { deployed: false, message: NOT_DEPLOYED };
  const f = await resolveFilter(env, filter);
  const [pass, word] = await env.client.readContract({ address: env.gate, abi: gateAbi, functionName: 'check', args: [token, BigInt(f.id)] });
  return {
    token,
    filter: `#${f.id} ${f.name}${f.stateful ? ' (latch)' : ''}`,
    state: pass ? 'unlatched' : 'latched',
    inputs: word,
    setBits: explainBits(word).filter((b) => b.value).map((b) => b.bit),
    note: 'Read on-chain from LatchGate.check (live TapeOut circuit). Not financial advice.',
  };
}

export async function listUnlatched(env: Env, filter: string | number, limit = 25) {
  if (!env.gate) return { deployed: false, message: NOT_DEPLOYED };
  const f = await resolveFilter(env, filter);
  const r = await fetch(`${env.ignixApi}/v1/launches`);
  const j = (await r.json()) as { data: { launches: { tokenAddress: Address; symbol: string; holders: number }[] } };
  const launches = j.data.launches;
  const pass: { token: Address; symbol: string; holders: number }[] = [];
  for (let i = 0; i < launches.length; i += 250) {
    const part = launches.slice(i, i + 250);
    const [passes] = await env.client.readContract({ address: env.gate, abi: gateAbi, functionName: 'checkMany', args: [part.map((l) => l.tokenAddress), BigInt(f.id)] });
    passes.forEach((p, k) => p && pass.push({ token: part[k].tokenAddress, symbol: part[k].symbol, holders: part[k].holders }));
  }
  pass.sort((a, b) => b.holders - a.holders);
  return { filter: `#${f.id} ${f.name}`, unlatched: pass.length, of: launches.length, top: pass.slice(0, limit) };
}

export async function explainLatch(env: Env, token: string) {
  if (!isAddress(token)) throw new Error('token must be a 0x address');
  if (!env.gate) return { deployed: false, message: NOT_DEPLOYED };
  const word = await env.client.readContract({ address: env.gate, abi: gateAbi, functionName: 'inputs', args: [token] });
  const all = await filters(env);
  const verdicts = [];
  for (const f of all) {
    try {
      const [pass] = await env.client.readContract({ address: env.gate, abi: gateAbi, functionName: 'check', args: [token, BigInt(f.id)] });
      verdicts.push({ filter: `#${f.id} ${f.name}`, state: pass ? 'unlatched' : 'latched' });
    } catch (e) {
      verdicts.push({ filter: `#${f.id} ${f.name}`, state: `unavailable (${(e as Error).message.split('\n')[0]})` });
    }
  }
  return { token, inputs: word, bits: explainBits(word), filters: verdicts };
}

export async function lockGuide(env: Env, token: string) {
  if (!isAddress(token)) throw new Error('token must be a 0x address');
  const steps = [
    'Pick unlock circuits: combinational filters only (latch filters are rejected as unlock conditions). UNLOCK_T1 and UNLOCK_T2 are the starters.',
    'Split the allocation into tranches (basis points summing to 10,000), one unlock circuit each, up to 8 tranches.',
    'Approve LatchLock for the amount, then call createLock(token, amount, beneficiary, tranches). The fee is taken in the token from what LatchLock actually receives.',
    'Nothing about the lock can change afterwards. Anyone can call release(lockId, trancheIdx); tokens only ever go to the beneficiary, and only when the circuit passes.',
    'Keeping at least the minimum share of supply locked sets LATCH_LOCKED, which filters like STRICT reward.',
  ];
  if (!env.lock) return { deployed: false, message: NOT_DEPLOYED, steps };
  const [feeBps, minLockBps, locks] = await Promise.all([
    env.client.readContract({ address: env.lock, abi: lockAbi, functionName: 'feeBps' }),
    env.client.readContract({ address: env.lock, abi: lockAbi, functionName: 'minLockBps' }),
    env.client.readContract({ address: env.lock, abi: lockAbi, functionName: 'locksByToken', args: [token] }),
  ]);
  return { token, lockContract: env.lock, feePercent: feeBps / 100, minLockPercentForLatchLocked: minLockBps / 100, existingLocks: locks.length, steps };
}

export async function feedStatus(env: Env) {
  if (!env.feed) return { deployed: false, message: NOT_DEPLOYED };
  const [fresh, last] = await Promise.all([
    env.client.readContract({ address: env.feed, abi: feedAbi, functionName: 'isFresh' }),
    env.client.readContract({ address: env.feed, abi: feedAbi, functionName: 'lastHeartbeat' }),
  ]);
  return { fresh, lastHeartbeat: new Date(Number(last) * 1000).toISOString() };
}
