// LP custody per graduated launch. v2: LP ERC-20 held by the recognised v2 locker (plus burned LP).
// v4: the position NFT held by the recognised v4 locker, and that position's liquidity.
// "Pulled" = the locked amount fell below THRESHOLDS.lpPulledBelowPeak of the highest value we have observed, or the
// NFT left the locker. Peaks persist across cycles, so a pull is detected even if the pool is refilled later.
import { createPublicClient, http, parseAbi, type Address } from 'viem';
import { xLayer } from 'viem/chains';
import { BURN_ADDRESSES, IGNIX, RECOGNISED_LOCKERS, RPC, THRESHOLDS } from './config.ts';
import type { Launch } from './ignix.ts';

const V2_LOCKER = Object.entries(RECOGNISED_LOCKERS).find(([, v]) => v.venue === 'v2')![0] as Address;
const V4_LOCKER = Object.entries(RECOGNISED_LOCKERS).find(([, v]) => v.venue === 'v4')![0] as Address;

const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function totalSupply() view returns (uint256)']);
const posm = parseAbi([
  'function ownerOf(uint256) view returns (address)',
  'function getPositionLiquidity(uint256) view returns (uint128)',
]);

export interface LpState {
  peak: Record<Address, string>;
  /** Tokens whose LP was ever seen pulled. Monotonic: never cleared (LatchFeed enforces the same on-chain). */
  pulled?: Record<Address, number>;
}

export interface LpInfo {
  venue: 'v2' | 'v4';
  locked: bigint; // v2: LP tokens locked+burned; v4: position liquidity if the locker holds the NFT, else 0
  supply: bigint | null; // v2 LP total supply
  holder: string | null; // v4 NFT owner
  peak: bigint;
  lpLocked: boolean;
  lpPulled: boolean;
}

export async function readLp(launches: Launch[], state: LpState): Promise<Map<Address, LpInfo>> {
  const client = createPublicClient({ chain: xLayer, transport: http(RPC.read), batch: { multicall: { batchSize: 4096 } } });
  const grad = launches.filter((l) => l.graduated);
  const out = new Map<Address, LpInfo>();

  const v2 = grad.filter((l) => l.venue === 'v2' && l.pair);
  const v2calls = v2.flatMap((l) => [
    { address: l.pair!, abi: erc20, functionName: 'totalSupply' } as const,
    { address: l.pair!, abi: erc20, functionName: 'balanceOf', args: [V2_LOCKER] } as const,
    ...BURN_ADDRESSES.map((b) => ({ address: l.pair!, abi: erc20, functionName: 'balanceOf', args: [b as Address] }) as const),
  ]);
  const v2res = await client.multicall({ contracts: v2calls, allowFailure: true });
  const per = 2 + BURN_ADDRESSES.length;
  v2.forEach((l, i) => {
    const r = v2res.slice(i * per, (i + 1) * per).map((x) => (x.status === 'success' ? (x.result as bigint) : 0n));
    // 1000 wei of LP is always minted to 0x0 by UniV2 (MINIMUM_LIQUIDITY); it is not "locked" liquidity.
    const burned = r.slice(2).reduce((a, b) => a + b, 0n) - 1000n;
    const locked = r[1] + (burned > 0n ? burned : 0n);
    out.set(l.tokenAddress, finish(state, l.tokenAddress, 'v2', locked, r[0], null));
  });

  const v4 = grad.filter((l) => l.venue === 'v4' && l.lpTokenId);
  const v4calls = v4.flatMap((l) => [
    { address: IGNIX.v4PositionManager as Address, abi: posm, functionName: 'ownerOf', args: [BigInt(l.lpTokenId!)] } as const,
    { address: IGNIX.v4PositionManager as Address, abi: posm, functionName: 'getPositionLiquidity', args: [BigInt(l.lpTokenId!)] } as const,
  ]);
  const v4res = await client.multicall({ contracts: v4calls, allowFailure: true });
  v4.forEach((l, i) => {
    const owner = v4res[2 * i].status === 'success' ? String(v4res[2 * i].result).toLowerCase() : null;
    const liq = v4res[2 * i + 1].status === 'success' ? BigInt(v4res[2 * i + 1].result as bigint) : 0n;
    const locked = owner === V4_LOCKER ? liq : 0n;
    out.set(l.tokenAddress, finish(state, l.tokenAddress, 'v4', locked, null, owner));
  });
  return out;
}

/** Exported for tests. LP_PULLED is monotonic: once recorded in `state.pulled` it is never cleared. */
export function finish(state: LpState, token: Address, venue: 'v2' | 'v4', locked: bigint, supply: bigint | null, holder: string | null): LpInfo {
  const prev = BigInt(state.peak[token] ?? '0');
  const peak = locked > prev ? locked : prev;
  state.peak[token] = peak.toString();
  const floor = (peak * BigInt(Math.round(THRESHOLDS.lpPulledBelowPeak * 10_000))) / 10_000n;
  const pulled = (state.pulled ??= {});
  if (peak > 0n && locked < floor && !pulled[token]) pulled[token] = Math.floor(Date.now() / 1000);
  const lpPulled = pulled[token] !== undefined;
  // A graduated launch whose LP was never seen in a recognised locker is neither locked nor "pulled" (no evidence).
  return { venue, locked, supply, holder, peak, lpLocked: locked > 0n && !lpPulled, lpPulled };
}
