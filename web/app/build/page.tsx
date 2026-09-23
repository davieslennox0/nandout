'use client';

import { compile, type BitName } from '@latch/compiler';
import { useMemo, useState } from 'react';
import { decodeEventLog, formatEther } from 'viem';
import { useAccount, usePublicClient, useReadContract, useReadContracts, useWriteContract } from 'wagmi';
import { NotDeployed } from '@/components/NotDeployed';
import { gateAbi, processorAbi, transistorsAbi } from '@/lib/abi';
import { BIT_LABELS, BIT_NAMES, isOnchain } from '@/lib/bits';
import { DEPLOYMENT, EXPLORER } from '@/lib/config';

type Mode = 'off' | 'require' | 'forbid' | 'any';

function toDsl(modes: Record<BitName, Mode>): unknown | null {
  const req = BIT_NAMES.filter((b) => modes[b] === 'require');
  const forbid = BIT_NAMES.filter((b) => modes[b] === 'forbid').map((b) => ({ not: b }));
  const any = BIT_NAMES.filter((b) => modes[b] === 'any');
  const parts: unknown[] = [...req, ...forbid];
  if (any.length === 1) parts.push(any[0]);
  if (any.length > 1) parts.push({ any });
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0] : { all: parts };
}

export default function BuildPage() {
  const [modes, setModes] = useState<Record<BitName, Mode>>(() => Object.fromEntries(BIT_NAMES.map((b) => [b, 'off'])) as Record<BitName, Mode>);
  const [raw, setRaw] = useState<string | null>(null);
  const [name, setName] = useState('MY_FILTER');
  const built = toDsl(modes);
  const dslText = raw ?? (built ? JSON.stringify(built) : '');

  const result = useMemo(() => {
    if (!dslText) return null;
    try {
      return { ok: true as const, c: compile(name || 'CUSTOM', JSON.parse(dslText)) };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  }, [dslText, name]);

  return (
    <>
      <h1>Build a filter</h1>
      <p className="lede">
        Pick conditions, and the rule compiles to NAND gates in your browser. Every one of the 65,536 input
        combinations is checked against your rule before anything can be taped out. Taping out burns transistors from the
        Nandout processor and mints the circuit as an NFT; registering it makes it a LatchGate filter anyone can call.
      </p>

      <div className="section-label">Conditions<span>must / must not / any of</span></div>
      <div className="bit-grid">
        {BIT_NAMES.map((b) => (
          <div key={b} className="bit-toggle" title={b}>
            <span>
              {BIT_LABELS[b]}
              {isOnchain(b) && <span className="chip" style={{ marginLeft: 6 }}>on-chain</span>}
            </span>
            <select value={modes[b]} onChange={(e) => { setRaw(null); setModes({ ...modes, [b]: e.target.value as Mode }); }}>
              <option value="off">—</option>
              <option value="require">must</option>
              <option value="forbid">must not</option>
              <option value="any">any of</option>
            </select>
          </div>
        ))}
      </div>

      <div className="section-label">Rule<span>the exact DSL that gets compiled</span></div>
      <p className="muted small">
        Edit directly for nested rules or a sticky latch: <code>{'{"latch":{"set":…,"reset":…}}'}</code>.
      </p>
      <textarea className="mono" rows={3} value={dslText} onChange={(e) => setRaw(e.target.value)} placeholder="Choose conditions above" />
      <label>Name</label>
      <input className="mono" value={name} onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))} />

      <div className="section-label">Circuit<span>compiled in your browser</span></div>
      {!result && <div className="card empty">Pick at least one condition.</div>}
      {result && !result.ok && <div className="bar warn">{result.error}</div>}
      {result?.ok && <CircuitPreview c={result.c} />}
    </>
  );
}

function CircuitPreview({ c }: { c: ReturnType<typeof compile> }) {
  return (
    <div className="grid g2">
      <div className="card">
        <div className="row"><span className="chip green">Verified</span><span className="muted small">against all 65,536 inputs{c.nState ? ' × 2 latch states' : ''}</span></div>
        <p className="mono" style={{ margin: '12px 0 4px', color: 'var(--accent)' }}>{c.infix}</p>
        <table>
          <tbody>
            <tr><td className="muted">Transistors burned</td><td className="mono">{c.nandCount} NAND{c.latchCount ? ` + ${c.latchCount} LATCH` : ''}</td></tr>
            <tr><td className="muted">Kind</td><td>{c.kind === 'latch' ? 'latch (sticky), cannot be used as an unlock circuit' : 'combinational'}</td></tr>
            <tr><td className="muted">Est. eval gas</td><td className="mono">~{c.estEvalGas.internalCall.toLocaleString()} (free for off-chain reads)</td></tr>
            <tr><td className="muted">Netlist hash</td><td className="mono small" style={{ wordBreak: 'break-all' }}>{c.netlistHash}</td></tr>
          </tbody>
        </table>
      </div>
      <TapeOut c={c} />
    </div>
  );
}

function TapeOut({ c }: { c: ReturnType<typeof compile> }) {
  const { address } = useAccount();
  const pub = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const transistors = useReadContract({ address: DEPLOYMENT.processor, abi: processorAbi, functionName: 'transistors', query: { enabled: Boolean(DEPLOYMENT.processor) } });
  const t = transistors.data;
  const info = useReadContracts({
    contracts: t
      ? [
          { address: t, abi: transistorsAbi, functionName: 'mintPrice' },
          { address: t, abi: transistorsAbi, functionName: 'protocolFee' },
          { address: DEPLOYMENT.processor!, abi: processorAbi, functionName: 'TAPEOUT_FEE' },
          { address: t, abi: transistorsAbi, functionName: 'supplyCap' },
          { address: t, abi: transistorsAbi, functionName: 'minted' },
        ]
      : [],
    query: { enabled: Boolean(t) },
  });

  if (!DEPLOYMENT.processor || !DEPLOYMENT.gate) return <div className="card"><NotDeployed what="Tape-out from this page" /></div>;
  const [price, protoFee, tapeFee, cap, minted] = (info.data ?? []).map((r) => (r.status === 'success' ? (r.result as bigint) : undefined));
  const mints = (c.nandCount > 0 ? 1n : 0n) + (c.latchCount > 0 ? 1n : 0n);
  const cost = price !== undefined && protoFee !== undefined && tapeFee !== undefined ? price * BigInt(c.gateCount) + protoFee * mints + tapeFee : undefined;
  const left = cap !== undefined && minted !== undefined ? cap - minted : undefined;

  async function run() {
    if (!pub || !t || cost === undefined) return;
    setBusy(true);
    const say = (s: string) => setLog((l) => [...l, s]);
    try {
      for (const [id, n] of [[0n, c.nandCount], [1n, c.latchCount]] as const) {
        if (n === 0) continue;
        const h = await writeContractAsync({ address: t, abi: transistorsAbi, functionName: 'mint', args: [id, BigInt(n)], value: price! * BigInt(n) + protoFee! });
        say(`minted ${n} ${id === 0n ? 'NAND' : 'LATCH'}: ${h}`);
        await pub.waitForTransactionReceipt({ hash: h });
      }
      const h = await writeContractAsync({ address: DEPLOYMENT.processor!, abi: processorAbi, functionName: 'tapeout', args: [c.netlist, c.nIn, c.nOut], value: tapeFee! });
      say(`taped out: ${h}`);
      const r = await pub.waitForTransactionReceipt({ hash: h });
      const ev = r.logs.flatMap((l) => { try { return [decodeEventLog({ abi: processorAbi, ...l })]; } catch { return []; } }).find((e) => e.eventName === 'TapedOut');
      if (!ev || ev.eventName !== 'TapedOut') throw new Error('TapedOut event not found');
      const cid = ev.args.circuitId;
      say(`circuit #${cid}`);
      const h2 = await writeContractAsync({ address: DEPLOYMENT.gate!, abi: gateAbi, functionName: 'registerFilter', args: [DEPLOYMENT.processor!, cid, c.name, c.netlistHash] });
      await pub.waitForTransactionReceipt({ hash: h2 });
      say(`registered as a LatchGate filter: ${h2}`);
    } catch (e) {
      say(`error: ${(e as Error).message.split('\n')[0]}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <table>
        <tbody>
          <tr><td className="muted">Transistor price</td><td className="mono">{price !== undefined ? `${formatEther(price)} OKB` : '…'}</td></tr>
          <tr><td className="muted">Tape-out fee (TapeOut)</td><td className="mono">{tapeFee !== undefined ? `${formatEther(tapeFee)} OKB` : '…'}</td></tr>
          <tr><td className="muted">Total</td><td className="mono"><b>{cost !== undefined ? `${formatEther(cost)} OKB` : '…'}</b></td></tr>
          <tr><td className="muted">Transistors left</td><td className="mono">{left?.toString() ?? '…'}</td></tr>
        </tbody>
      </table>
      <div className="row" style={{ marginTop: '0.8rem' }}>
        <button className="primary" disabled={!address || busy || cost === undefined || (left !== undefined && left < BigInt(c.gateCount))} onClick={run}>
          {busy ? 'Working…' : 'Mint, tape out & register'}
        </button>
        {!address && <span className="muted small">Connect a wallet first.</span>}
      </div>
      {log.length > 0 && <pre className="log">{log.join('\n')}</pre>}
      <p className="muted small">Processor: <a href={`${EXPLORER}/address/${DEPLOYMENT.processor}`}>{DEPLOYMENT.processor}</a></p>
    </div>
  );
}
