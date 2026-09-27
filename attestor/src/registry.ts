// Durable registry of every launch the attestor has ever seen.
//
// Ignix's /v1/launches returns only the newest 5,000 launches and ignores page/limit, so older launches silently
// drop out of the index. They still exist on-chain and may back live locks, so they must keep being attested: their
// on-chain bits (holders, top-10, dev outflows, LP) are recomputed every cycle like any other launch, and their
// API-only fields (agent link, revenue, graduation/pair) are refreshed through /v1/launches/{token} on a budget.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Address } from 'viem';
import { IGNIX } from './config.ts';
import type { Launch } from './ignix.ts';
import { lower } from './config.ts';

export interface Entry {
  launch: Launch | null; // null until the API has returned data for it at least once
  firstSeen: number; // unix seconds
  lastSeenInIndex: number | null;
  inIndex: boolean;
  apiRefreshedAt: number | null;
  apiError: string | null;
  lastAttestedAt: number | null;
  lastBits: number | null;
  lastChangeAt: number | null;
}

export interface Registry { version: 1; entries: Record<Address, Entry> }

export const emptyRegistry = (): Registry => ({ version: 1, entries: {} });

export function loadRegistry(file: string): Registry {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Registry) : emptyRegistry();
}

export function saveRegistry(file: string, r: Registry): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(r));
  renameSync(`${file}.tmp`, file);
}

/**
 * Folds this cycle's index into the registry. Launches in the index are refreshed; everything else is kept and marked
 * outside the index. `knownTokens` seeds entries for tokens the attestor indexed before the registry existed.
 */
export function mergeIndex(r: Registry, index: Launch[], now: number, knownTokens: Iterable<string> = []): void {
  const seen = new Set<string>();
  for (const l of index) {
    const t = lower(l.tokenAddress);
    seen.add(t);
    const prev = r.entries[t];
    r.entries[t] = {
      launch: l,
      firstSeen: prev?.firstSeen ?? now,
      lastSeenInIndex: now,
      inIndex: true,
      apiRefreshedAt: now,
      apiError: null,
      lastAttestedAt: prev?.lastAttestedAt ?? null,
      lastBits: prev?.lastBits ?? null,
      lastChangeAt: prev?.lastChangeAt ?? null,
    };
  }
  for (const k of knownTokens) {
    const t = lower(k);
    if (!r.entries[t]) {
      r.entries[t] = { launch: null, firstSeen: now, lastSeenInIndex: null, inIndex: false, apiRefreshedAt: null, apiError: null, lastAttestedAt: null, lastBits: null, lastChangeAt: null };
    }
  }
  for (const [t, e] of Object.entries(r.entries)) if (!seen.has(t)) e.inIndex = false;
}

/**
 * Which out-of-index launches get an API refresh this cycle. Order: never-fetched entries, then (a) tokens backing an
 * active lock, (b) tokens whose bits changed in the last 24 h, (c) the rest by oldest refresh (round-robin).
 * Locked tokens are always included, even beyond the budget.
 */
export function selectRefresh(r: Registry, locked: Set<string>, now: number, budget: number): Address[] {
  const out = Object.entries(r.entries).filter(([, e]) => !e.inIndex);
  const rank = ([t, e]: [string, Entry]) =>
    e.launch === null ? 0 : locked.has(t) ? 1 : e.lastChangeAt !== null && now - e.lastChangeAt < 86_400 ? 2 : 3;
  out.sort((a, b) => rank(a) - rank(b) || (a[1].apiRefreshedAt ?? 0) - (b[1].apiRefreshedAt ?? 0));
  const picked = out.slice(0, budget).map(([t]) => t);
  for (const [t] of out) if (locked.has(t) && !picked.includes(t)) picked.push(t);
  return picked as Address[];
}

/** Refreshes the chosen entries from /v1/launches/{token}, a few at a time, well under Ignix's 600 req/min. */
export async function refreshFromApi(
  r: Registry,
  tokens: Address[],
  now: number,
  fetchOne: (t: Address) => Promise<Launch> = fetchLaunch,
  concurrency = 3,
): Promise<{ ok: number; failed: number }> {
  let ok = 0, failed = 0, i = 0;
  const worker = async () => {
    while (i < tokens.length) {
      const t = tokens[i++];
      const e = r.entries[t];
      try {
        e.launch = await fetchOne(t);
        e.apiRefreshedAt = now;
        e.apiError = null;
        ok++;
      } catch (err) {
        e.apiError = String((err as Error).message).slice(0, 120);
        failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { ok, failed };
}

export async function fetchLaunch(token: Address): Promise<Launch> {
  const res = await fetch(`${IGNIX.api}/v1/launches/${token}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = (await res.json()) as { code: number; data?: unknown };
  return normalizeSingle(j);
}

/**
 * /v1/launches/{token} differs from the index: `holders` is a top-holder list and the count is `holderCount`.
 * Normalise to the index shape so the rest of the attestor sees one Launch type.
 */
export function normalizeSingle(j: { code: number; data?: unknown }): Launch {
  const d = j.data as (Omit<Launch, 'holders'> & { holders?: unknown; holderCount?: number }) | undefined;
  if (j.code !== 200 || !d?.tokenAddress) throw new Error('unexpected payload');
  const holders = typeof d.holders === 'number' ? d.holders : typeof d.holderCount === 'number' ? d.holderCount : 0;
  const { holderCount: _hc, ...rest } = d;
  const l = { ...rest, holders } as Launch;
  return {
    ...l,
    tokenAddress: lower(l.tokenAddress), creator: lower(l.creator),
    pair: l.pair ? lower(l.pair) : null,
    dividendTracker: l.dividendTracker ? lower(l.dividendTracker) : null,
    taxRouter: l.taxRouter ? lower(l.taxRouter) : null,
    splitter: l.splitter ? lower(l.splitter) : null,
  };
}

/** Every launch the attestor can attest this cycle: the index plus out-of-index entries with known data. */
export function launchesForCycle(r: Registry): Launch[] {
  return Object.values(r.entries).flatMap((e) => (e.launch ? [e.launch] : []));
}

/** Records this cycle's result per token: last attested time and when its bits last changed. */
export function recordAttestations(r: Registry, results: { token: string; bits: number }[], now: number): void {
  for (const { token, bits } of results) {
    const e = r.entries[lower(token)];
    if (!e) continue;
    if (e.lastBits !== null && e.lastBits !== bits) e.lastChangeAt = now;
    if (e.lastBits === null) e.lastChangeAt = now;
    e.lastBits = bits;
    e.lastAttestedAt = now;
  }
}
