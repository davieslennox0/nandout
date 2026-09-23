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

/** What the launch list needs per row (kept small: the full index is ~4,000 launches). */
export interface Row {
  t: `0x${string}`; // token
  s: string; // symbol
  n: string; // name
  h: number; // holders
  g: boolean; // graduated
  v: string; // venue
  a: number | null; // agent id
  r: number | null; // agent revenue
  i: string | null; // image
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

export const toRow = (l: Launch): Row => ({
  t: l.tokenAddress, s: l.symbol, n: l.name, h: l.holders, g: l.graduated, v: l.venue,
  a: l.asp?.id ?? null, r: l.asp?.rev ?? null, i: l.image,
});
