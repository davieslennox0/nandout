// Addresses and thresholds. Every address here was observed on X Layer mainnet (docs/RECON.md §2).
import type { Address } from 'viem';

export const CHAIN_ID = 196;

export const IGNIX = {
  api: process.env.IGNIX_API_URL ?? 'https://api.ignix.bot',
  /** Launchpad / bonding curve: holds unsold supply pre-graduation; dev sells on the curve go here. */
  launchpad: '0x96b51c57e5346d0c0198899243cf851d1e23c309',
  /** Uniswap-v4-style PoolManager: holds v4 pool liquidity. */
  v4PoolManager: '0x360e68faccca8ca495c1b759fd9eee466db9fb32',
  /** v4 position NFT (PositionManager). */
  v4PositionManager: '0xcf1eafc6928dc385a342e7c6491d371d2871458b',
} as const satisfies Record<string, string>;

/**
 * LP lockers Latch recognises. Both are UNVERIFIED bytecode used by Ignix for every graduated launch; decoded
 * selectors show lock/claim/harvest/accrued and no withdraw, but that is not proven (RECON §2.3).
 */
export const RECOGNISED_LOCKERS: Record<string, { venue: 'v2' | 'v4'; note: string }> = {
  '0xed707fc375c6a27e4330d3d38a939ba55bb2b99a': { venue: 'v2', note: 'Ignix v2 LP locker (unverified)' },
  '0x560d9f6025c3537e7610695c760ada761d0a0d6a': { venue: 'v4', note: 'Ignix v4 position locker (unverified)' },
};

export const BURN_ADDRESSES = ['0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead'];

export const THRESHOLDS = {
  revLow: 100,
  revHigh: 1000,
  top10Loose: 0.4,
  top10Strict: 0.25,
  holdersLow: 100,
  holdersHigh: 300,
  devSellWindowSec: 7 * 24 * 3600,
  /** Locked LP (v2 locker balance / v4 position liquidity) below this share of its observed peak = pulled. */
  lpPulledBelowPeak: 0.9,
} as const;

export const RPC = {
  /** Plain reads (public node). */
  read: process.env.XLAYER_RPC_URL ?? 'https://rpc.xlayer.tech',
  /**
   * eth_getLogs backfill. Public X Layer nodes cap log ranges at 100 blocks; Ignix's own RPC allows 5,000 blocks and
   * 1,000 addresses per call. Third-party infra: fine for development, replace with our own provider for production.
   */
  logs: process.env.LOG_RPC_URL ?? 'https://rpc.ignix.bot/rpc/196',
  logRange: Number(process.env.LOG_RANGE ?? 5000),
  logAddresses: Number(process.env.LOG_ADDRESSES ?? 1000),
  logConcurrency: Number(process.env.LOG_CONCURRENCY ?? 4),
};

export const lower = (a: string) => a.toLowerCase() as Address;
