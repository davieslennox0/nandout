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

/** Advances latch filters (snapshotMany) and returns pass lists per filter. */
export async function evaluateFilters(
  { pub, wallet }: ReturnType<typeof clients>,
  d: Deployment,
  tokens: Address[],
  chunk = 250,
): Promise<Record<string, { filterId: number; stateful: boolean; pass: Address[] }>> {
  const out: Record<string, { filterId: number; stateful: boolean; pass: Address[] }> = {};
  for (const [name, id] of Object.entries(d.filters ?? {})) {
    const f = await pub.readContract({ address: d.gate, abi: gateAbi, functionName: 'getFilter', args: [BigInt(id)] });
    const stateful = f.nState > 0;
    const pass: Address[] = [];
    for (let i = 0; i < tokens.length; i += chunk) {
      const part = tokens.slice(i, i + chunk);
      if (stateful && wallet) {
        const hash = await wallet.writeContract({ address: d.gate, abi: gateAbi, functionName: 'snapshotMany', args: [part, BigInt(id)], chain: wallet.chain, account: wallet.account! });
        await pub.waitForTransactionReceipt({ hash });
      }
      const [passes] = await pub.readContract({ address: d.gate, abi: gateAbi, functionName: 'checkMany', args: [part, BigInt(id)] });
      passes.forEach((p, j) => p && pass.push(part[j]));
    }
    out[name] = { filterId: id, stateful, pass };
  }
  return out;
}
