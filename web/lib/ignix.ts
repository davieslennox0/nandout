import { IGNIX_API } from './config';

export interface Launch {
  tokenAddress: `0x${string}`;
  creator: `0x${string}`;
  name: string;
  symbol: string;
  createdTime: string;
  graduated: boolean;
  venue: 'v2' | 'v4';
  pair: string | null;
  holders: number;
  image: string | null;
  asp: { id: number; name: string; matched: string; rev: number | null } | null;
}

/** Ignix public launch index (docs/RECON.md §2). Cached for 60 s on the server. */
export async function fetchLaunches(): Promise<Launch[]> {
  const r = await fetch(`${IGNIX_API}/v1/launches`, { next: { revalidate: 60 } });
  if (!r.ok) throw new Error(`Ignix API HTTP ${r.status}`);
  const j = (await r.json()) as { code: number; data?: { launches?: Launch[] } };
  if (j.code !== 200 || !j.data?.launches) throw new Error('Ignix API: unexpected payload');
  return j.data.launches;
}

/** Launches with any signal first: graduated, agent-linked, then by holders. */
export function rank(ls: Launch[]): Launch[] {
  const score = (l: Launch) => (l.graduated ? 1e7 : 0) + (l.asp ? 1e6 : 0) + l.holders;
  return [...ls].sort((a, b) => score(b) - score(a));
}
