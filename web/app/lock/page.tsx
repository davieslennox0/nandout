'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { formatUnits, isAddress, parseUnits, type Address } from 'viem';
import { useAccount, usePublicClient, useReadContract, useReadContracts, useWriteContract } from 'wagmi';
import { NotDeployed } from '@/components/NotDeployed';
import { short } from '@/components/Wallet';
import { erc20Abi, gateAbi, lockAbi } from '@/lib/abi';
import { DEPLOYMENT, deployed } from '@/lib/config';
import { useFilters } from '@/lib/hooks';

const fmt = (v: bigint, d: number) => Number(formatUnits(v, d)).toLocaleString('en-US', { maximumFractionDigits: 4 });

interface PreviewFilter { id: number; name: string; starter: string | null; stateful: boolean; circuitId: string }
interface Side { pass: boolean; kind: string; why: string[] }
interface Preview {
  filters: PreviewFilter[];
  known?: boolean;
  reason?: string;
  block?: string;
  creator?: string;
  isCreator?: boolean;
  latchLockedNow?: boolean;
  latchLockedAfter?: boolean;
  latchNote?: string;
  needGross?: string;
  fresh?: boolean;
  results?: (PreviewFilter & { chain?: { pass: boolean } | { error: string }; before: Side | null; after: Side | null })[];
}

/** Tranche templates over the starter unlock circuits (matched by netlist hash server-side, not by name). */
const PRESETS: { label: string; note: string; tranches: [string, number][] }[] = [
  { label: 'Two-step 50 / 50', note: 'half on UNLOCK_T1 (≥7 days, LP locked, ≥100 holders), half on UNLOCK_T2 (≥30 days, revenue ≥$10, ≥300 holders, LP locked)', tranches: [['UNLOCK_T1', 50], ['UNLOCK_T2', 50]] },
  { label: 'Back-loaded 25 / 75', note: 'a quarter early on UNLOCK_T1, the rest on UNLOCK_T2', tranches: [['UNLOCK_T1', 25], ['UNLOCK_T2', 75]] },
  { label: 'All on UNLOCK_T2', note: 'nothing releases before 30 days and real agent revenue', tranches: [['UNLOCK_T2', 100]] },
  { label: 'All on UNLOCK_T1', note: 'the lightest schedule: 7 days, LP locked, 100 holders', tranches: [['UNLOCK_T1', 100]] },
];

export default function LockPage() {
  return (
    <>
      <h1>Lock a creator allocation</h1>
      <p className="lede">
        Tokens are released tranche by tranche, only to the beneficiary, and only when each tranche&apos;s unlock circuit
        passes. After creation nothing can change: no admin, no pause, no circuit swap. Releases are evaluated by the sealed
        LatchEvaluator, never by TapeOut&apos;s upgradeable contracts. Keeping at least the minimum share of supply locked
        sets <code>LATCH_LOCKED</code>, which stricter filters reward. Only locks from the wallet recorded as the launch&apos;s creator
        count toward it. <Link href="/creators">What locking proves, and what it costs</Link>.
      </p>
      {!deployed ? <NotDeployed what="Creating and releasing locks" /> : (<><CreateLock /><MyLocks /></>)}
    </>
  );
}

function CreateLock() {
  const { address } = useAccount();
  const pub = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const router = useRouter();
  const { filters } = useFilters();
  const unlockFilters = filters.filter((f) => f.nState === 0); // latch filters are rejected as unlock circuits
  const statefulFilters = filters.filter((f) => f.nState > 0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [token, setToken] = useState('');
  const [amount, setAmount] = useState('');
  const [beneficiary, setBeneficiary] = useState('');
  const [tranches, setTranches] = useState<{ filterId: number; pct: string }[]>([{ filterId: 0, pct: '100' }]);
  const [status, setStatus] = useState<string>('');

  const tok = isAddress(token) ? (token as Address) : undefined;
  const meta = useReadContracts({
    contracts: tok
      ? [
          { address: tok, abi: erc20Abi, functionName: 'symbol' },
          { address: tok, abi: erc20Abi, functionName: 'decimals' },
          { address: tok, abi: erc20Abi, functionName: 'balanceOf', args: [address ?? '0x0000000000000000000000000000000000000000'] },
        ]
      : [],
    query: { enabled: Boolean(tok) },
  });
  const feeBps = useReadContract({ address: DEPLOYMENT.lock, abi: lockAbi, functionName: 'feeBps' });
  const [symbol, decimals, balance] = (meta.data ?? []).map((r) => (r.status === 'success' ? r.result : undefined)) as [string?, number?, bigint?];
  const d = decimals ?? 18;
  let raw: bigint | undefined;
  try { raw = amount ? parseUnits(amount, d) : undefined; } catch { raw = undefined; }
  const bps = feeBps.data !== undefined ? BigInt(feeBps.data) : undefined;
  const fee = raw !== undefined && bps !== undefined ? (raw * bps) / 10_000n : undefined;
  const bpsSum = tranches.reduce((s, t) => s + Math.round(Number(t.pct) * 100), 0);
  const ben = (beneficiary || address) as Address | undefined;
  const valid = tok && raw && raw > 0n && ben && isAddress(ben) && bpsSum === 10_000 && tranches.every((t) => t.filterId > 0);

  const rawKey = raw !== undefined ? raw.toString() : '0';
  useEffect(() => {
    const q = new URLSearchParams({ ...(tok ? { token: tok } : {}), ...(address ? { wallet: address } : {}), amount: rawKey });
    const ac = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/lock-preview?${q}`, { signal: ac.signal }).then((r) => r.json()).then(setPreview).catch(() => {});
    }, 350);
    return () => { clearTimeout(t); ac.abort(); };
  }, [tok, address, rawKey]);
  const starterId = (name: string) => preview?.filters.find((f) => f.starter === name && !f.stateful)?.id;

  async function submit() {
    if (!valid || !pub || !tok || raw === undefined || !address) return;
    try {
      const allowance = await pub.readContract({ address: tok, abi: erc20Abi, functionName: 'allowance', args: [address, DEPLOYMENT.lock!] });
      if (allowance < raw) {
        setStatus('Approving…');
        const h = await writeContractAsync({ address: tok, abi: erc20Abi, functionName: 'approve', args: [DEPLOYMENT.lock!, raw] });
        await pub.waitForTransactionReceipt({ hash: h });
      }
      setStatus('Creating lock…');
      const h = await writeContractAsync({
        address: DEPLOYMENT.lock!,
        abi: lockAbi,
        functionName: 'createLock',
        args: [tok, raw, ben!, tranches.map((t) => ({ filterId: BigInt(t.filterId), bps: Math.round(Number(t.pct) * 100) }))],
      });
      const rc = await pub.waitForTransactionReceipt({ hash: h });
      if (rc.status !== 'success') throw new Error(`createLock reverted (tx ${h})`);
      setStatus(`Locked. Tx ${h}. Opening the lock page…`);
      router.push(`/lock/${tok.toLowerCase()}?created=1`);
    } catch (e) {
      setStatus(`Error: ${(e as Error).message.split('\n')[0]}`);
    }
  }

  return (
    <div className="card" style={{ marginTop: 28 }}>
      <h3>New lock</h3>
      <div className="grid g2">
        <div>
          <label>Token</label>
          <input className="mono" placeholder="0x…" value={token} onChange={(e) => setToken(e.target.value.trim())} />
          {symbol && <p className="muted small">{symbol} · your balance {balance !== undefined ? fmt(balance, d) : '…'} · <Link href={`/lock/${tok!.toLowerCase()}`}>current lock status</Link></p>}
          <label>Amount</label>
          <input className="mono" placeholder="10000000" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <label>Beneficiary (defaults to you)</label>
          <input className="mono" placeholder={address ?? '0x…'} value={beneficiary} onChange={(e) => setBeneficiary(e.target.value.trim())} />
        </div>
        <div>
          <label>Templates</label>
          <div className="row" style={{ marginBottom: 10 }}>
            {PRESETS.map((p) => {
              const ids = p.tranches.map(([n]) => starterId(n));
              const ready = ids.every((x) => x !== undefined);
              return (
                <button key={p.label} className="ghost small" disabled={!ready} title={p.note}
                  onClick={() => setTranches(p.tranches.map(([, pct], i) => ({ filterId: ids[i]!, pct: String(pct) })))}>
                  {p.label}
                </button>
              );
            })}
          </div>
          <label>Tranches (percentages must sum to 100)</label>
          {tranches.map((t, i) => (
            <div className="row" key={i} style={{ marginBottom: 6 }}>
              <select value={t.filterId} onChange={(e) => setTranches(tranches.map((x, j) => (j === i ? { ...x, filterId: Number(e.target.value) } : x)))} style={{ flex: 2 }}>
                <option value={0}>Unlock circuit…</option>
                {unlockFilters.map((f) => <option key={f.id} value={f.id}>#{f.id} {f.name}</option>)}
                {statefulFilters.map((f) => <option key={f.id} value={f.id} disabled>#{f.id} {f.name} (stateful: rejected)</option>)}
              </select>
              <input className="mono" style={{ flex: 1 }} value={t.pct} onChange={(e) => setTranches(tranches.map((x, j) => (j === i ? { ...x, pct: e.target.value } : x)))} />
              <span className="muted">%</span>
              {tranches.length > 1 && <button className="ghost small" onClick={() => setTranches(tranches.filter((_, j) => j !== i))}>×</button>}
            </div>
          ))}
          {tranches.length < 8 && <button className="ghost small" onClick={() => setTranches([...tranches, { filterId: 0, pct: '0' }])}>+ tranche</button>}
          {bpsSum !== 10_000 && <p className="error small">Tranches sum to {bpsSum / 100}%.</p>}
          {statefulFilters.length > 0 && (
            <p className="muted small">
              Stateful (latch) filters such as {statefulFilters.map((f) => f.name).join(', ')} cannot be unlock circuits: LatchLock rejects them
              (<code>StatefulUnlock</code>) because their answer depends on remembered history, while releases are evaluated statelessly.
            </p>
          )}
        </div>
      </div>
      {raw !== undefined && fee !== undefined && bps !== undefined && (
        <div className="fee-line">
          Lock {fmt(raw, d)} → {fmt(raw - fee, d)} locked, {fmt(fee, d)} fee ({Number(bps) / 100}%)
        </div>
      )}
      <PreviewPanel preview={preview} hasToken={Boolean(tok)} />
      <p className="muted small">
        The fee is taken from what the contract actually receives, so tokens with a transfer tax lock slightly less than shown.
      </p>
      <div className="row">
        <button className="primary" disabled={!valid || !address} onClick={submit}>Approve & lock</button>
        {status && <span className="small muted mono">{status}</span>}
      </div>
    </div>
  );
}

function PreviewPanel({ preview, hasToken }: { preview: Preview | null; hasToken: boolean }) {
  if (!hasToken) return null;
  if (!preview) return <p className="muted small">Reading filters for this token…</p>;
  if (preview.reason) return <div className="bar warn"><span className="dot amber" />{preview.reason}</div>;
  if (!preview.results) return null;
  const changed = preview.results.filter((r) => r.before && r.after && r.before.pass !== r.after.pass);
  return (
    <div style={{ marginTop: 16 }}>
      <div className={`bar ${preview.latchLockedAfter && !preview.latchLockedNow ? 'live' : ''}`}>
        <span className={`dot ${preview.latchLockedAfter ? '' : 'amber'}`} />
        {preview.latchNote}
      </div>
      <table style={{ marginTop: 10 }}>
        <thead><tr><th>Filter</th><th>Now</th><th>After this lock</th></tr></thead>
        <tbody>
          {preview.results.map((r) => (
            <tr key={r.id}>
              <td>{r.name}{r.stateful && <span className="muted small"> · stateful</span>}</td>
              <td><Verdict s={r.before} /></td>
              <td><Verdict s={r.after} changed={Boolean(r.before && r.after && r.before.pass !== r.after.pass)} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">
        Computed from the circuits with the same inputs LatchGate reads at block {preview.block}; the only input a lock can change is LATCH_LOCKED.
        {changed.length === 0 ? ' This lock changes no filter result.' : ` This lock changes: ${changed.map((c) => c.name).join(', ')}.`}
        {!preview.fresh && ' The feed is stale right now, so live checks revert until the attestor posts again.'}
      </p>
    </div>
  );
}

function Verdict({ s, changed }: { s: Side | null; changed?: boolean }) {
  if (!s) return <span className="muted small">no netlist</span>;
  return (
    <div>
      <span className={s.pass ? 'unlatched' : 'latched'}>{s.pass ? 'passes' : 'latched'}</span>
      {changed && <span className="chip green" style={{ marginLeft: 6 }}>changes</span>}
      <div className="muted small">{s.kind === 'unmet' ? 'not met: ' : s.kind === 'reset' ? '' : 'on: '}{s.why.join(' · ')}</div>
    </div>
  );
}

function MyLocks() {
  const { address } = useAccount();
  const ids = useReadContract({ address: DEPLOYMENT.lock, abi: lockAbi, functionName: 'locksByBeneficiary', args: [address!], query: { enabled: Boolean(address) } });
  const list = ids.data ?? [];
  const locks = useReadContracts({
    contracts: list.map((id) => ({ address: DEPLOYMENT.lock!, abi: lockAbi, functionName: 'getLock' as const, args: [id] as const })),
    query: { enabled: list.length > 0 },
  });
  return (
    <>
      <div className="section-label">Your claims<span>locks where this wallet is the beneficiary</span></div>
      {!address && <div className="card empty">Connect a wallet to see locks where you are the beneficiary.</div>}
      {address && list.length === 0 && !ids.isLoading && <div className="card empty">No locks name this wallet as beneficiary.</div>}
      {(locks.data ?? []).map((r, i) =>
        r.status === 'success' ? <LockCard key={String(list[i])} id={list[i]} lock={r.result[0]} tranches={r.result[1]} /> : null,
      )}
    </>
  );
}

function LockCard({ id, lock, tranches }: {
  id: bigint;
  lock: { token: Address; depositor: Address; amount: bigint; released: bigint };
  tranches: readonly { filterId: bigint; bps: number; released: boolean; amount: bigint }[];
}) {
  const pub = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const [msg, setMsg] = useState('');
  const checks = useReadContracts({
    contracts: tranches.map((t) => ({ address: DEPLOYMENT.gate!, abi: gateAbi, functionName: 'checkLocal' as const, args: [lock.token, t.filterId] as const })),
  });
  async function release(idx: number) {
    try {
      const h = await writeContractAsync({ address: DEPLOYMENT.lock!, abi: lockAbi, functionName: 'release', args: [id, BigInt(idx)] });
      await pub!.waitForTransactionReceipt({ hash: h });
      setMsg(`Released. Tx ${h}`);
    } catch (e) {
      setMsg(`Error: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  return (
    <div className="card" style={{ marginBottom: '0.75rem' }}>
      <div className="row"><h3 style={{ margin: 0 }}>Lock #{id.toString()}</h3><span className="mono muted">token {short(lock.token)} · from {short(lock.depositor)}</span></div>
      <table>
        <thead><tr><th>Tranche</th><th>Unlock filter</th><th>Amount</th><th>Circuit</th><th /></tr></thead>
        <tbody>
          {tranches.map((t, i) => {
            const c = checks.data?.[i];
            const pass = c?.status === 'success' ? c.result[0] : undefined;
            return (
              <tr key={i}>
                <td>{i}</td>
                <td>#{t.filterId.toString()} · {t.bps / 100}%</td>
                <td className="mono">{t.amount.toString()}</td>
                <td>{t.released ? <span className="muted">released</span> : pass === undefined ? <span className="muted">{c?.status === 'failure' ? 'feed stale' : '…'}</span> : pass ? <span className="unlatched">passes</span> : <span className="latched">latched</span>}</td>
                <td>{!t.released && <button className="primary small" disabled={!pass} onClick={() => release(i)}>Release</button>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {msg && <p className="small mono">{msg}</p>}
    </div>
  );
}
