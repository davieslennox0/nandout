'use client';

import { useState } from 'react';
import { formatUnits, isAddress, parseUnits, type Address } from 'viem';
import { useAccount, usePublicClient, useReadContract, useReadContracts, useWriteContract } from 'wagmi';
import { NotDeployed } from '@/components/NotDeployed';
import { short } from '@/components/Wallet';
import { erc20Abi, gateAbi, lockAbi } from '@/lib/abi';
import { DEPLOYMENT, deployed } from '@/lib/config';
import { useFilters } from '@/lib/hooks';

const fmt = (v: bigint, d: number) => Number(formatUnits(v, d)).toLocaleString(undefined, { maximumFractionDigits: 4 });

export default function LockPage() {
  return (
    <>
      <h1>Lock a creator allocation</h1>
      <p className="lede">
        Tokens are released tranche by tranche, only to the beneficiary, and only when each tranche&apos;s unlock circuit
        passes. After creation nothing can change: no admin, no pause, no circuit swap. Releases are evaluated by the sealed
        LatchEvaluator, never by TapeOut&apos;s upgradeable contracts. Keeping at least the minimum share of supply locked
        sets <code>LATCH_LOCKED</code>, which stricter filters reward.
      </p>
      {!deployed ? <NotDeployed what="Creating and releasing locks" /> : (<><CreateLock /><MyLocks /></>)}
    </>
  );
}

function CreateLock() {
  const { address } = useAccount();
  const pub = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { filters } = useFilters();
  const unlockFilters = filters.filter((f) => f.nState === 0); // latch filters are rejected as unlock circuits
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
      await pub.waitForTransactionReceipt({ hash: h });
      setStatus(`Locked. Tx ${h}`);
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
          {symbol && <p className="muted small">{symbol} · your balance {balance !== undefined ? fmt(balance, d) : '…'}</p>}
          <label>Amount</label>
          <input className="mono" placeholder="10000000" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <label>Beneficiary (defaults to you)</label>
          <input className="mono" placeholder={address ?? '0x…'} value={beneficiary} onChange={(e) => setBeneficiary(e.target.value.trim())} />
        </div>
        <div>
          <label>Tranches (percentages must sum to 100)</label>
          {tranches.map((t, i) => (
            <div className="row" key={i} style={{ marginBottom: 6 }}>
              <select value={t.filterId} onChange={(e) => setTranches(tranches.map((x, j) => (j === i ? { ...x, filterId: Number(e.target.value) } : x)))} style={{ flex: 2 }}>
                <option value={0}>Unlock circuit…</option>
                {unlockFilters.map((f) => <option key={f.id} value={f.id}>#{f.id} {f.name}</option>)}
              </select>
              <input className="mono" style={{ flex: 1 }} value={t.pct} onChange={(e) => setTranches(tranches.map((x, j) => (j === i ? { ...x, pct: e.target.value } : x)))} />
              <span className="muted">%</span>
              {tranches.length > 1 && <button className="ghost small" onClick={() => setTranches(tranches.filter((_, j) => j !== i))}>×</button>}
            </div>
          ))}
          {tranches.length < 8 && <button className="ghost small" onClick={() => setTranches([...tranches, { filterId: 0, pct: '0' }])}>+ tranche</button>}
          {bpsSum !== 10_000 && <p className="error small">Tranches sum to {bpsSum / 100}%.</p>}
        </div>
      </div>
      {raw !== undefined && fee !== undefined && bps !== undefined && (
        <div className="fee-line">
          Lock {fmt(raw, d)} → {fmt(raw - fee, d)} locked, {fmt(fee, d)} fee ({Number(bps) / 100}%)
        </div>
      )}
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
