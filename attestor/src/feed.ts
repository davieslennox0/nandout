// Writes attestations to LatchFeed (only tokens whose bits changed) and evaluates filters through LatchGate.
import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { xLayer } from 'viem/chains';
import type { Attestation } from './bits.ts';

export const feedAbi = parseAbi([
  'function post((address token, uint16 bits, uint64 launchTime, address creator)[] updates)',
  'function heartbeat()',
  'function getBits(address token) view returns (uint16 bits, uint64 updatedAt, uint64 launchTime, address creator)',
  'function isFresh() view returns (bool)',
]);

export const gateAbi = parseAbi([
  'function checkMany(address[] tokens, uint256 filterId) view returns (bool[] passes, uint16[] ins)',
  'function snapshotMany(address[] tokens, uint256 filterId)',
  'function checkLocal(address token, uint256 filterId) view returns (bool pass, uint16 inputs)',
  'function slotOf(address token, uint256 filterId) view returns ((bytes state, uint16 inputs, bool pass, bool seen, uint64 atBlock))',
  'function getFilter(uint256) view returns ((address cpu, uint64 circuitId, uint32 gateCount, uint32 nState, address netlistPointer, bytes32 netlistHash, address registrant, string name))',
]);

export interface Deployment { feed: Address; gate: Address; lock: Address; filters?: Record<string, number> }

export function clients(rpcUrl: string, key?: Hex) {
  const chain = { ...xLayer, rpcUrls: { default: { http: [rpcUrl] } } };
  const pub = createPublicClient({ chain, transport: http(rpcUrl), batch: { multicall: { batchSize: 4096 } } });
  const wallet = key ? createWalletClient({ chain, transport: http(rpcUrl), account: privateKeyToAccount(key) }) : undefined;
  return { pub, wallet };
}

export async function diffAgainstFeed(pub: ReturnType<typeof clients>['pub'], feed: Address, atts: Attestation[]) {
  const res = await pub.multicall({
    contracts: atts.map((a) => ({ address: feed, abi: feedAbi, functionName: 'getBits', args: [a.token] }) as const),
    allowFailure: false,
  });
  return atts.filter((a, i) => {
    const [bits, , launchTime] = res[i] as readonly [number, bigint, bigint, Address];
    return launchTime === 0n || bits !== a.bits;
  });
}

export async function postChanged(
  { pub, wallet }: ReturnType<typeof clients>,
  feed: Address,
  changed: Attestation[],
  batch = 200,
): Promise<Hex[]> {
  if (!wallet) throw new Error('posting needs an attestor key');
  const hashes: Hex[] = [];
  for (let i = 0; i < changed.length; i += batch) {
    const updates = changed.slice(i, i + batch).map((a) => ({
      token: a.token, bits: a.bits, launchTime: BigInt(a.launchTime), creator: a.creator,
    }));
    const est = await pub.estimateContractGas({ address: feed, abi: feedAbi, functionName: 'post', args: [updates], account: wallet.account! });
    const hash = await wallet.writeContract({ address: feed, abi: feedAbi, functionName: 'post', args: [updates], chain: wallet.chain, account: wallet.account!, gas: (est * 5n) / 4n });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error(`post reverted: ${hash}`);
    hashes.push(hash);
  }
  if (changed.length === 0) {
    const hash = await wallet.writeContract({ address: feed, abi: feedAbi, functionName: 'heartbeat', chain: wallet.chain, account: wallet.account! });
    await pub.waitForTransactionReceipt({ hash });
    hashes.push(hash);
  }
  return hashes;
}

/**
 * Advances latch filters and returns pass lists per filter.
 *
 * A latch's next state depends only on (stored state, current inputs), so a snapshot is only needed where the result
 * would change what is stored. We compare checkLocal (what a snapshot would store, a free view) with slotOf (what is
 * stored) and snapshot only the differences. Unseen tokens with a false result need no write: an unseen slot already
 * reads as "latched, state 0".
 */
export async function evaluateFilters(
  { pub, wallet }: ReturnType<typeof clients>,
  d: Deployment,
  tokens: Address[],
  chunk = 250,
): Promise<Record<string, { filterId: number; stateful: boolean; pass: Address[]; snapshotted?: number }>> {
  const out: Record<string, { filterId: number; stateful: boolean; pass: Address[]; snapshotted?: number }> = {};
  for (const [name, id] of Object.entries(d.filters ?? {})) {
    const fid = BigInt(id);
    const f = await pub.readContract({ address: d.gate, abi: gateAbi, functionName: 'getFilter', args: [fid] });
    const stateful = f.nState > 0;
    let snapshotted = 0;
    if (stateful && wallet) {
      const reads = await pub.multicall({
        contracts: tokens.flatMap((t) => [
          { address: d.gate, abi: gateAbi, functionName: 'checkLocal', args: [t, fid] } as const,
          { address: d.gate, abi: gateAbi, functionName: 'slotOf', args: [t, fid] } as const,
        ]),
        allowFailure: true,
      });
      const todo = tokens.filter((_, i) => {
        const next = reads[2 * i];
        const slot = reads[2 * i + 1];
        if (next.status !== 'success' || slot.status !== 'success') return false; // unknown to the feed
        const [pass] = next.result as readonly [boolean, number];
        const s = slot.result as { pass: boolean; seen: boolean };
        return s.seen ? s.pass !== pass : pass;
      });
      for (let i = 0; i < todo.length; i += chunk) {
        const part = todo.slice(i, i + chunk);
        const est = await pub.estimateContractGas({ address: d.gate, abi: gateAbi, functionName: 'snapshotMany', args: [part, fid], account: wallet.account! });
        const hash = await wallet.writeContract({ address: d.gate, abi: gateAbi, functionName: 'snapshotMany', args: [part, fid], chain: wallet.chain, account: wallet.account!, gas: (est * 5n) / 4n });
        const r = await pub.waitForTransactionReceipt({ hash });
        if (r.status !== 'success') throw new Error(`snapshotMany reverted: ${hash}`);
      }
      snapshotted = todo.length;
    }
    const pass: Address[] = [];
    for (let i = 0; i < tokens.length; i += chunk) {
      const part = tokens.slice(i, i + chunk);
      const [passes] = await pub.readContract({ address: d.gate, abi: gateAbi, functionName: 'checkMany', args: [part, fid] });
      passes.forEach((p, j) => p && pass.push(part[j]));
    }
    out[name] = { filterId: id, stateful, pass, ...(stateful ? { snapshotted } : {}) };
  }
  return out;
}
