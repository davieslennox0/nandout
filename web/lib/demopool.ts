// Server-side reads for NexusHook's disclosed demo pool: live facts/tier from the hook, the LP position, and every swap
// the PoolManager has recorded for the pool since it was created (so any outside usage is visible, never invented).
import { parseAbi, type Address, type Hex } from 'viem';
import { client } from './lockview';

export const HOOK_V2: Address = '0xfd77af872A8f590680Fd27D79319e2e4E08E80c4';
export const HOOK_V1_DEPRECATED: Address = '0x9553B82Baf7EB83e155b33F003d89Aa1D1b040cc';
export const XCAT: Address = '0xbB9A906f1A8906D548C5D94b7079fA31bF09EEee';
export const POOL_ID: Hex = '0x806bfd9c404564f6f26de8355dc9a54dfab0064af57841d872124a8185a32671';
export const POSITION_ID = 12817n;
export const POOL_CREATED_BLOCK = 71815113;
const PM: Address = '0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32';
const POSM: Address = '0xcF1EAFC6928dC385A342E7C6491d371d2871458b';
const LOG_RPC = process.env.LOG_RPC_URL || 'https://rpc.ignix.bot/rpc/196';
const SWAP_TOPIC = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';

const key = { currency0: '0x0000000000000000000000000000000000000000', currency1: XCAT, fee: 0x800000, tickSpacing: 60, hooks: HOOK_V2 } as const;
const hookAbi = parseAbi([
  'function currentFacts((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key) view returns (uint8)',
  'function tierOf(uint8) view returns (uint8)',
  'function feeOfTier(uint8) view returns (uint24)',
]);
const posmAbi = parseAbi(['function getPositionLiquidity(uint256) view returns (uint128)', 'function ownerOf(uint256) view returns (address)']);

export interface PoolSwap { tx: Hex; block: number; sender: Address; fee: number }
export interface DemoPool { block: bigint; facts: number; tier: number; feePips: number; liquidity: bigint; owner: Address; swaps: PoolSwap[] | null }

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch(LOG_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), next: { revalidate: 120 } });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result as T;
}

async function swaps(head: bigint): Promise<PoolSwap[] | null> {
  try {
    const out: PoolSwap[] = [];
    for (let from = POOL_CREATED_BLOCK; from <= Number(head); from += 5000) {
      const to = Math.min(Number(head), from + 4999);
      const logs = await rpc<{ transactionHash: Hex; blockNumber: string; topics: Hex[]; data: Hex }[]>('eth_getLogs', [
        { address: PM, topics: [SWAP_TOPIC, POOL_ID], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` },
      ]);
      for (const l of logs) {
        out.push({ tx: l.transactionHash, block: parseInt(l.blockNumber, 16), sender: `0x${l.topics[2].slice(26)}` as Address, fee: parseInt(l.data.slice(2 + 64 * 5, 2 + 64 * 6), 16) });
      }
    }
    return out;
  } catch {
    return null;
  }
}

export async function readDemoPool(): Promise<DemoPool> {
  const block = await client.getBlockNumber();
  const [facts, liquidity, owner] = await Promise.all([
    client.readContract({ address: HOOK_V2, abi: hookAbi, functionName: 'currentFacts', args: [key] }),
    client.readContract({ address: POSM, abi: posmAbi, functionName: 'getPositionLiquidity', args: [POSITION_ID] }),
    client.readContract({ address: POSM, abi: posmAbi, functionName: 'ownerOf', args: [POSITION_ID] }),
  ]);
  const tier = await client.readContract({ address: HOOK_V2, abi: hookAbi, functionName: 'tierOf', args: [facts] });
  const feePips = await client.readContract({ address: HOOK_V2, abi: hookAbi, functionName: 'feeOfTier', args: [tier] });
  return { block, facts, tier, feePips, liquidity, owner, swaps: await swaps(block) };
}
