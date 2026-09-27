import type { Address } from 'viem';
import { IGNIX, lower } from './config.ts';

/** The subset of an Ignix `/v1/launches` entry the attestor uses (schema in docs/RECON.md §2.2). */
export interface Launch {
  tokenAddress: Address;
  creator: Address;
  name: string;
  symbol: string;
  createdTime: string;
  createdTx: string;
  graduated: boolean;
  venue: 'v2' | 'v4';
  pair: Address | null;
  poolId: string | null;
  lpTokenId: string | null;
  dividendTracker: Address | null;
  taxRouter: Address | null;
  splitter: Address | null;
  holders: number;
  image?: string | null;
  asp: { id: number; name: string; matched: string; rev: number | null } | null;
}

export async function fetchLaunches(): Promise<Launch[]> {
  const r = await fetch(`${IGNIX.api}/v1/launches`, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`ignix /v1/launches: HTTP ${r.status}`);
  const j = (await r.json()) as { code: number; data?: { launches?: Launch[] } };
  if (j.code !== 200 || !Array.isArray(j.data?.launches)) throw new Error('ignix /v1/launches: unexpected payload');
  return j.data.launches.map((l) => ({
    ...l,
    tokenAddress: lower(l.tokenAddress),
    creator: lower(l.creator),
    pair: l.pair ? lower(l.pair) : null,
    dividendTracker: l.dividendTracker ? lower(l.dividendTracker) : null,
    taxRouter: l.taxRouter ? lower(l.taxRouter) : null,
    splitter: l.splitter ? lower(l.splitter) : null,
  }));
}
