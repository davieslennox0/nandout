// Server-side reader for one token's lock + filter state. Every number comes from X Layer at a single block, which is
// returned so pages can label the snapshot. Reasons for pass/fail are derived from the circuit itself (see explain.ts).
import { compile, decode as decodeNetlist, N_IN, N_OUT, parseCircuit, STARTERS, type Circuit } from '@latch/compiler';
import { createPublicClient, hexToBytes, http, isAddress, parseAbi, type Address, type Hex } from 'viem';
import { xLayer } from 'viem/chains';
import { gateAbi, lockAbi } from './abi';
import { DEPLOYMENT, RPC } from './config';

const feedAbi = parseAbi([
  'function getBits(address) view returns (uint16 bits, uint64 updatedAt, uint64 launchTime, address creator)',
  'function isFresh() view returns (bool)',
  'function lastHeartbeat() view returns (uint64)',
]);
const lockReadAbi = parseAbi([
  'function lockedOf(address, address) view returns (uint256)',
  'function isLocked(address, address) view returns (bool)',
]);
const gateReadAbi = parseAbi([
  'function netlistOf(uint256) view returns (bytes)',
  'function slotOf(address, uint256) view returns ((bytes state, uint16 inputs, bool pass, bool seen, uint64 atBlock))',
]);
const tokenAbi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
]);

export const client = createPublicClient({ chain: xLayer, transport: http(RPC), batch: { multicall: { batchSize: 4096 } } });

/** Known starter circuits, matched to on-chain filters by netlist hash (never by name, which anyone can choose). */
const KNOWN = new Map(
  Object.entries(STARTERS).map(([name, dsl]) => {
    const c = compile(name, dsl);
    return [c.netlistHash.toLowerCase(), { name, circuit: parseCircuit(dsl) }] as const;
  }),
);

export interface FilterView {
  id: number;
  name: string;
  circuitId: bigint;
  cpu: Address;
  gateCount: number;
  stateful: boolean;
  netlistHash: Hex;
  /** Rule from the matching starter DSL, or null for a third-party netlist (reasons then come from the netlist). */
  circuit: Circuit | null;
  /** Starter this filter's netlist is byte-identical to, if any. */
  starter: string | null;
  netlist: Hex | null;
}

export interface TrancheView {
  filterId: number;
  bps: number;
  amount: bigint;
  released: boolean;
}

export interface LockEntry {
  id: bigint;
  depositor: Address;
  beneficiary: Address;
  createdAt: number;
  amount: bigint;
  released: bigint;
  tranches: TrancheView[];
}

export interface TokenView {
  token: Address;
  block: bigint;
  blockTime: number;
  name: string | null;
  symbol: string | null;
  decimals: number;
  totalSupply: bigint | null;
  /** Registered in LatchFeed (launchTime != 0). */
  known: boolean;
  attested: number;
  updatedAt: number;
  launchTime: number;
  creator: Address | null;
  fresh: boolean;
  lastHeartbeat: number;
  /** LatchGate.inputs: attested bits + LATCH_LOCKED + age, exactly what circuits see. Null if unknown token. */
  inputs: number | null;
  creatorLocked: bigint;
  latchLocked: boolean;
  minLockBps: number;
  feeBps: number;
  locks: LockEntry[];
  filters: FilterView[];
  /** Live LatchGate.check per filter id. `error` when the call reverts (e.g. FeedStale). */
  checks: Record<number, { pass: boolean; inputs: number } | { error: string }>;
  /** Stored latch output for stateful filters (the "previous state" the live check starts from). */
  prevPass: Record<number, number>;
}

const ok = <T,>(r: { status: string; result?: unknown; error?: unknown }): T | undefined => (r.status === 'success' ? (r.result as T) : undefined);
const errName = (e: unknown) => {
  const m = String((e as Error)?.message ?? e);
  return /FeedStale/.test(m) ? 'FeedStale' : /UnknownToken/.test(m) ? 'UnknownToken' : 'reverted';
};

let filterCache: { at: number; filters: FilterView[] } | null = null;

/** Registered filters. Immutable once registered, so cached for 10 minutes (new registrations appear after that). */
export async function readFilters(): Promise<FilterView[]> {
  if (filterCache && Date.now() - filterCache.at < 600_000) return filterCache.filters;
  const gate = DEPLOYMENT.gate!;
  const n = Number(await client.readContract({ address: gate, abi: gateAbi, functionName: 'filterCount' }));
  const ids = Array.from({ length: n }, (_, i) => BigInt(i + 1));
  const infos = await client.multicall({ contracts: ids.map((id) => ({ address: gate, abi: gateAbi, functionName: 'getFilter', args: [id] }) as const), allowFailure: true });
  const unknown = infos.map((r, i) => ({ r, i })).filter(({ r }) => r.status === 'success' && !KNOWN.has(r.result!.netlistHash.toLowerCase()));
  const netlists = await client.multicall({ contracts: unknown.map(({ i }) => ({ address: gate, abi: gateReadAbi, functionName: 'netlistOf', args: [ids[i]] }) as const), allowFailure: true });
  const nlById = new Map(unknown.map(({ i }, k) => [i + 1, ok<Hex>(netlists[k]) ?? null]));
  const filters: FilterView[] = infos.flatMap((r, i) => {
    const f = ok<{ cpu: Address; circuitId: bigint; gateCount: number; nState: number; netlistHash: Hex; name: string }>(r);
    if (!f) return [];
    const k = KNOWN.get(f.netlistHash.toLowerCase());
    return [{ id: i + 1, name: f.name, circuitId: f.circuitId, cpu: f.cpu, gateCount: f.gateCount, stateful: f.nState > 0, netlistHash: f.netlistHash, circuit: k?.circuit ?? null, starter: k?.name ?? null, netlist: nlById.get(i + 1) ?? null }];
  });
  filterCache = { at: Date.now(), filters };
  return filters;
}

export async function readToken(token: Address): Promise<TokenView> {
  const { gate, lock, feed } = DEPLOYMENT as { gate: Address; lock: Address; feed: Address };
  const [block, filters] = await Promise.all([client.getBlock({ blockTag: 'latest' }), readFilters()]);
  const blockNumber = block.number;
  const at = { blockNumber } as const;

  const base = await client.multicall({
    ...at,
    allowFailure: true,
    contracts: [
      { address: token, abi: tokenAbi, functionName: 'name' },
      { address: token, abi: tokenAbi, functionName: 'symbol' },
      { address: token, abi: tokenAbi, functionName: 'decimals' },
      { address: token, abi: tokenAbi, functionName: 'totalSupply' },
      { address: feed, abi: feedAbi, functionName: 'getBits', args: [token] },
      { address: feed, abi: feedAbi, functionName: 'isFresh' },
      { address: feed, abi: feedAbi, functionName: 'lastHeartbeat' },
      { address: gate, abi: gateAbi, functionName: 'inputs', args: [token] },
      { address: lock, abi: lockAbi, functionName: 'minLockBps' },
      { address: lock, abi: lockAbi, functionName: 'feeBps' },
      { address: lock, abi: lockAbi, functionName: 'locksByToken', args: [token] },
    ] as const,
  });
  const [name, symbol, decimals, totalSupply, bits, fresh, heartbeat, inputs, minLockBps, feeBps, lockIds] = base;
  const fb = ok<readonly [number, bigint, bigint, Address]>(bits);
  const known = Boolean(fb && fb[2] > 0n);
  const creator = known ? fb![3] : null;

  const ids = ok<readonly bigint[]>(lockIds) ?? [];
  const second = await client.multicall({
    ...at,
    allowFailure: true,
    contracts: [
      ...(creator ? [{ address: lock, abi: lockReadAbi, functionName: 'lockedOf', args: [token, creator] } as const, { address: lock, abi: lockReadAbi, functionName: 'isLocked', args: [token, creator] } as const] : []),
      ...ids.map((id) => ({ address: lock, abi: lockAbi, functionName: 'getLock', args: [id] }) as const),
      ...(known ? filters.map((f) => ({ address: gate, abi: gateAbi, functionName: 'check', args: [token, BigInt(f.id)] }) as const) : []),
      ...(known ? filters.filter((f) => f.stateful).map((f) => ({ address: gate, abi: gateReadAbi, functionName: 'slotOf', args: [token, BigInt(f.id)] }) as const) : []),
    ],
  });
  let k = 0;
  const creatorLocked = creator ? ok<bigint>(second[k++]) ?? 0n : 0n;
  const latchLocked = creator ? ok<boolean>(second[k++]) ?? false : false;
  const locks: LockEntry[] = ids.flatMap((id) => {
    const r = ok<readonly [{ depositor: Address; beneficiary: Address; createdAt: bigint; amount: bigint; released: bigint }, readonly { filterId: bigint; bps: number; released: boolean; amount: bigint }[]]>(second[k++]);
    if (!r) return [];
    const [l, t] = r;
    return [{ id, depositor: l.depositor, beneficiary: l.beneficiary, createdAt: Number(l.createdAt), amount: l.amount, released: l.released, tranches: t.map((x) => ({ filterId: Number(x.filterId), bps: x.bps, amount: x.amount, released: x.released })) }];
  });
  const checks: TokenView['checks'] = {};
  if (known) {
    for (const f of filters) {
      const r = second[k++];
      checks[f.id] = r.status === 'success' ? { pass: (r.result as readonly [boolean, number])[0], inputs: (r.result as readonly [boolean, number])[1] } : { error: errName(r.error) };
    }
  }
  const prevPass: TokenView['prevPass'] = {};
  if (known) {
    for (const f of filters.filter((x) => x.stateful)) {
      const slot = ok<{ pass: boolean; seen: boolean }>(second[k++]);
      prevPass[f.id] = slot?.seen && slot.pass ? 1 : 0;
    }
  }

  return {
    token,
    block: blockNumber,
    blockTime: Number(block.timestamp),
    name: ok<string>(name) ?? null,
    symbol: ok<string>(symbol) ?? null,
    decimals: ok<number>(decimals) ?? 18,
    totalSupply: ok<bigint>(totalSupply) ?? null,
    known,
    attested: fb?.[0] ?? 0,
    updatedAt: Number(fb?.[1] ?? 0n),
    launchTime: Number(fb?.[2] ?? 0n),
    creator,
    fresh: ok<boolean>(fresh) ?? false,
    lastHeartbeat: Number(ok<bigint>(heartbeat) ?? 0n),
    inputs: ok<number>(inputs) ?? null,
    creatorLocked,
    latchLocked,
    minLockBps: ok<number>(minLockBps) ?? 500,
    feeBps: ok<number>(feeBps) ?? 50,
    locks,
    filters,
    checks,
    prevPass,
  };
}

export const parseToken = (s: string): Address | null => (isAddress(s) ? (s.toLowerCase() as Address) : null);

/** Decoded netlist for a third-party filter, so the explainer can reason about it without a DSL. */
export const netlistOf = (f: FilterView) => (f.netlist ? decodeNetlist(hexToBytes(f.netlist), N_IN, N_OUT) : null);
