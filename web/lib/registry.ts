import { readFile } from 'node:fs/promises';
import type { Row } from './ignix';

/**
 * The attestor's public registry (written every cycle to ATTEST_PUBLIC_DIR on this server). Ignix's index only returns
 * the newest 5,000 launches; older ones are still attested and are listed here so the site shows them too.
 */
export interface PublicRegistry {
  generatedAt: string;
  block: number;
  cycleAt: number;
  registered: number;
  unfetched: number;
  outside: { t: `0x${string}`; s: string; n: string; h: number; g: boolean; v: string; a: number | null; r: number | null; i: string | null; api: number | null; err: string | null; att: number | null }[];
}

const DIR = process.env.ATTEST_PUBLIC_DIR || '/srv/nandout/attest';

export async function readRegistry(): Promise<PublicRegistry | null> {
  try {
    return JSON.parse(await readFile(`${DIR}/registry.json`, 'utf8')) as PublicRegistry;
  } catch {
    return null;
  }
}

/** Out-of-index launches as list rows, flagged so the UI can say where their data comes from. */
export const outsideRows = (r: PublicRegistry | null): Row[] =>
  (r?.outside ?? []).map((o) => ({ t: o.t, s: o.s, n: o.n, h: typeof o.h === 'number' ? o.h : 0, g: o.g, v: o.v, a: o.a, r: o.r, i: o.i, x: true, f: o.api }));
