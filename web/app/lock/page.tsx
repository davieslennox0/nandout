'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { formatUnits, isAddress, parseUnits, zeroAddress, type Address } from 'viem';
import { useAccount, usePublicClient, useReadContract, useReadContracts, useSwitchChain, useWriteContract } from 'wagmi';
import { NotDeployed } from '@/components/NotDeployed';
import { short } from '@/components/Wallet';
import { erc20Abi, gateAbi, lockAbi } from '@/lib/abi';
import { DEPLOYMENT, deployed } from '@/lib/config';
import { useFilters } from '@/lib/hooks';
import { approvalStep, blockers, explainRevert, formatAmount, lockedAfterFee, XLAYER_CHAIN_ID } from '@/lib/lockrules';
import { decodeRevert, lockErrorsAbi } from '@/lib/revert';

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
  token?: string;
  minDeposit?: { raw: string; text: string };
  transfer?: { ok: true } | { ok: false; reason: string; error: string };
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
  const { address, chainId } = useAccount();
  const pub = usePublicClient({ chainId: XLAYER_CHAIN_ID });
  const { writeContractAsync } = useWriteContract();
  const { switchChain } = useSwitchChain();
  const router = useRouter();
  const { filters, isLoading: filtersLoading } = useFilters();
  const unlockFilters = filters.filter((f) => f.nState === 0); // latch filters are rejected as unlock circuits
  const statefulFilters = filters.filter((f) => f.nState > 0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [token, setToken] = useState('');
  const [amount, setAmount] = useState('');
  const [beneficiary, setBeneficiary] = useState('');
  const [tranches, setTranches] = useState<{ filterId: number; pct: string }[]>([{ filterId: 0, pct: '100' }]);
  const [status, setStatus] = useState<{ text: string; tone: 'muted' | 'error' | 'ok' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [sim, setSim] = useState<{ key: string; ok: boolean; text: string } | null>(null);

  const tok = isAddress(token) ? (token as Address) : undefined;
  const meta = useReadContracts({
    contracts: tok
      ? [
          { address: tok, abi: erc20Abi, functionName: 'symbol' },
          { address: tok, abi: erc20Abi, functionName: 'decimals' },
          { address: tok, abi: erc20Abi, functionName: 'balanceOf', args: [address ?? zeroAddress] },
          { address: tok, abi: erc20Abi, functionName: 'allowance', args: [address ?? zeroAddress, DEPLOYMENT.lock!] },
        ]
      : [],
    query: { enabled: Boolean(tok) },
  });
  const feeBps = useReadContract({ address: DEPLOYMENT.lock, abi: lockAbi, functionName: 'feeBps' });
  const [symbol, decimals, balance, allowance] = (meta.data ?? []).map((r) => (r.status === 'success' ? r.result : undefined)) as [string?, number?, bigint?, bigint?];
  const d = decimals ?? 18;
  const sym = symbol ?? 'tokens';
  let raw: bigint | undefined;
  try { raw = amount ? parseUnits(amount.replace(/[,_\s]/g, ''), d) : undefined; } catch { raw = undefined; }
  const bps = feeBps.data !== undefined ? feeBps.data : undefined;
  const fee = raw !== undefined && bps !== undefined ? (raw * BigInt(bps)) / 10_000n : undefined;
  const ben = (beneficiary || address) as Address | undefined;
  const trancheInputs = tranches.map((t) => ({ filterId: t.filterId, bps: Math.round(Number(t.pct) * 100) || 0 }));

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
  const previewFor = preview && tok && preview.token?.toLowerCase() === tok.toLowerCase() ? preview : null;

  const problems = [
    ...blockers({
      connected: Boolean(address),
      chainId,
      tokenValid: Boolean(tok),
      symbol: sym,
      decimals: d,
      amount: raw,
      balance,
      beneficiaryValid: Boolean(ben && isAddress(ben)),
      tranches: trancheInputs,
      filters: filters.map((f) => ({ id: f.id, name: f.name, stateful: f.nState > 0 })),
      transferable: previewFor?.transfer,
    }).filter((b) => !(filtersLoading && /not registered/.test(b))),
    ...(tok && symbol === undefined && !meta.isLoading ? ['This address does not look like an ERC-20 token.'] : []),
  ];
  const approval = approvalStep(allowance, raw);
  const args = tok && raw !== undefined && ben
    ? ([tok, raw, ben, trancheInputs.map((t) => ({ filterId: BigInt(t.filterId), bps: t.bps }))] as const)
    : undefined;
  const simKey = JSON.stringify([tok, rawKey, ben, trancheInputs, String(allowance), address]);

  // Simulate createLock whenever the draft is valid and approved, so the Lock button is only live for a call that succeeds.
  useEffect(() => {
    if (problems.length || !args || !pub || !address || (approval !== 'ok' && approval !== 'reapprove-lower')) return;
    let stale = false;
    const t = setTimeout(async () => {
      try {
        await pub.simulateContract({ account: address, address: DEPLOYMENT.lock!, abi: [...lockAbi, ...lockErrorsAbi], functionName: 'createLock', args });
        if (!stale) setSim({ key: simKey, ok: true, text: `Simulation passed at the latest block: ${formatAmount(lockedAfterFee(raw!, bps ?? 50), d, sym)} would be locked.` });
      } catch (e) {
        const r = decodeRevert(e);
        if (!stale) setSim({ key: simKey, ok: false, text: explainRevert(r.name, r.args, { symbol: sym, decimals: d, filters: filters.map((f) => ({ id: f.id, name: f.name, stateful: f.nState > 0 })) }) + (r.name ? '' : ` (${r.raw?.slice(0, 10) ?? r.message})`) });
      }
    }, 400);
    return () => { stale = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simKey, problems.length, approval]);
  const simNow = sim && sim.key === simKey ? sim : null;

  const ctx = { symbol: sym, decimals: d, filters: filters.map((f) => ({ id: f.id, name: f.name, stateful: f.nState > 0 })) };
  const fail = (e: unknown, what: string) => {
    const r = decodeRevert(e);
    setStatus({ tone: 'error', text: r.userRejected ? `${what} cancelled in the wallet.` : r.name ? explainRevert(r.name, r.args, ctx) : `${what} failed: ${r.message}` });
  };

  async function approve() {
    if (problems.length || !tok || raw === undefined || !pub || !address) return;
    setBusy(true);
    try {
      await pub.simulateContract({ account: address, address: tok, abi: [...erc20Abi, ...lockErrorsAbi], functionName: 'approve', args: [DEPLOYMENT.lock!, raw] });
      setStatus({ tone: 'muted', text: `Approving exactly ${formatAmount(raw, d, sym)}…` });
      const h = await writeContractAsync({ address: tok, abi: erc20Abi, functionName: 'approve', args: [DEPLOYMENT.lock!, raw], chainId: XLAYER_CHAIN_ID });
      const rc = await pub.waitForTransactionReceipt({ hash: h });
      if (rc.status !== 'success') throw new Error(`approve reverted (tx ${h})`);
      await meta.refetch();
      setStatus({ tone: 'ok', text: `Approved ${formatAmount(raw, d, sym)}. Now create the lock.` });
    } catch (e) { fail(e, 'Approve'); } finally { setBusy(false); }
  }

  async function lock() {
    if (problems.length || !args || !pub || !address || !tok) return;
    setBusy(true);
    try {
      // Re-simulate right before prompting: the wallet only ever sees a call that succeeds at the latest block.
      const { request } = await pub.simulateContract({ account: address, address: DEPLOYMENT.lock!, abi: [...lockAbi, ...lockErrorsAbi], functionName: 'createLock', args });
      setStatus({ tone: 'muted', text: 'Creating lock…' });
      const h = await writeContractAsync({ ...request, chainId: XLAYER_CHAIN_ID });
      const rc = await pub.waitForTransactionReceipt({ hash: h });
      if (rc.status !== 'success') throw new Error(`createLock reverted (tx ${h})`);
      setStatus({ tone: 'ok', text: `Locked. Tx ${h}. Opening the lock page…` });
      router.push(`/lock/${tok.toLowerCase()}?created=1`);
    } catch (e) { fail(e, 'Lock'); } finally { setBusy(false); }
  }

  const approveLabel = approval === 'reapprove-lower'
    ? `Reduce approval to exactly ${raw !== undefined ? formatAmount(raw, d, sym) : ''}`
    : `1 · Approve ${raw !== undefined ? formatAmount(raw, d, sym) : ''}`;
  const canLock = !problems.length && (approval === 'ok' || approval === 'reapprove-lower') && Boolean(simNow?.ok) && !busy;

  return (
    <div className="card" style={{ marginTop: 28 }}>
      <h3>New lock</h3>
      <div className="grid g2">
        <div>
          <label>Token</label>
          <input className="mono" placeholder="0x…" value={token} onChange={(e) => setToken(e.target.value.trim())} />
          {symbol && (
            <p className="muted small">
              {symbol} · your balance {balance !== undefined ? formatAmount(balance, d, symbol) : '…'} · approved for LatchLock{' '}
              {allowance !== undefined ? formatAmount(allowance, d, symbol) : '…'} · <Link href={`/lock/${tok!.toLowerCase()}`}>current lock status</Link>
            </p>
          )}
          <label>Amount</label>
          <input className="mono" placeholder="10,000,000" value={amount} onChange={(e) => setAmount(e.target.value)} />
          {balance !== undefined && balance > 0n && <button className="linkish small" onClick={() => setAmount(formatUnits(balance, d))}>Use full balance</button>}
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
          {statefulFilters.length > 0 && (
            <p className="muted small">
              Stateful (latch) filters such as {statefulFilters.map((f) => f.name).join(', ')} cannot be unlock circuits: LatchLock rejects them
              (<code>StatefulUnlock</code>) because their answer depends on remembered history, while releases are evaluated statelessly.
            </p>
          )}
        </div>
      </div>
      {raw !== undefined && raw > 0n && fee !== undefined && bps !== undefined && (
        <div className="fee-line">
          Lock {formatAmount(raw, d, sym)} → {formatAmount(raw - fee, d, sym)} locked, {formatAmount(fee, d, sym)} fee ({bps / 100}%)
        </div>
      )}
      <PreviewPanel preview={previewFor} hasToken={Boolean(tok)} />
      {problems.length > 0 && (
        <ul className="reasons" style={{ margin: '14px 0' }}>
          {problems.map((p) => <li key={p} className="no">{p}</li>)}
        </ul>
      )}
      {!problems.length && simNow && <p className={`small ${simNow.ok ? 'ok' : 'error'}`}>{simNow.text}</p>}
      <div className="row" style={{ marginTop: 12 }}>
        {address && chainId !== XLAYER_CHAIN_ID && <button className="primary" onClick={() => switchChain({ chainId: XLAYER_CHAIN_ID })}>Switch to X Layer</button>}
        {(approval === 'needed' || approval === 'reapprove-lower') && (
          <button className={approval === 'needed' ? 'primary' : 'ghost'} disabled={problems.length > 0 || busy} onClick={approve}>{approveLabel}</button>
        )}
        <button className="primary" disabled={!canLock} onClick={lock}>{approval === 'needed' ? '2 · Lock' : 'Lock'}</button>
        {status && <span className={`small mono ${status.tone === 'error' ? 'error' : status.tone === 'ok' ? 'ok' : 'muted'}`}>{status.text}</span>}
      </div>
      <p className="muted small">
        Nothing is sent to your wallet until every check above passes and the lock has been simulated against the latest block.
        The fee is taken from what LatchLock actually receives.
      </p>
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
              <td><Verdict s={r.before} stateful={r.stateful} /></td>
              <td><Verdict s={r.after} stateful={r.stateful} changed={Boolean(r.before && r.after && r.before.pass !== r.after.pass)} /></td>
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

function Verdict({ s, changed, stateful }: { s: Side | null; changed?: boolean; stateful?: boolean }) {
  if (!s) return <span className="muted small">no netlist</span>;
  return (
    <div>
      <span className={s.pass ? 'unlatched' : 'latched'}>{s.pass ? 'passes' : stateful ? 'latched' : 'fails'}</span>
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
  const { address } = useAccount();
  const checks = useReadContracts({
    contracts: tranches.map((t) => ({ address: DEPLOYMENT.gate!, abi: gateAbi, functionName: 'checkLocal' as const, args: [lock.token, t.filterId] as const })),
  });
  const meta = useReadContracts({
    contracts: [
      { address: lock.token, abi: erc20Abi, functionName: 'symbol' },
      { address: lock.token, abi: erc20Abi, functionName: 'decimals' },
    ],
  });
  const sym = meta.data?.[0]?.status === 'success' ? (meta.data[0].result as string) : '';
  const dec = meta.data?.[1]?.status === 'success' ? (meta.data[1].result as number) : 18;
  async function release(idx: number) {
    try {
      const { request } = await pub!.simulateContract({ account: address, address: DEPLOYMENT.lock!, abi: [...lockAbi, ...lockErrorsAbi], functionName: 'release', args: [id, BigInt(idx)] });
      const h = await writeContractAsync(request);
      const rc = await pub!.waitForTransactionReceipt({ hash: h });
      setMsg(rc.status === 'success' ? `Released. Tx ${h}` : `Release reverted (tx ${h}).`);
    } catch (e) {
      const r = decodeRevert(e);
      setMsg(r.userRejected ? 'Release cancelled in the wallet.' : r.name ? explainRevert(r.name, r.args, { symbol: sym, decimals: dec }) : `Release failed: ${r.message}`);
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
                <td>{i + 1}</td>
                <td>#{t.filterId.toString()} · {t.bps / 100}%</td>
                <td>{formatAmount(t.amount, dec, sym)}</td>
                <td>{t.released ? <span className="muted">released</span> : pass === undefined ? <span className="muted">{c?.status === 'failure' ? 'feed stale' : '…'}</span> : pass ? <span className="unlatched">passes</span> : <span className="latched">fails</span>}</td>
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
