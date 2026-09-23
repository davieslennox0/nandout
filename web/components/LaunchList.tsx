'use client';

import { useEffect, useMemo, useState } from 'react';
import { useReadContracts } from 'wagmi';
import { gateAbi } from '@/lib/abi';
import { BIT_LABELS, decode, isOnchain } from '@/lib/bits';
import { DEPLOYMENT, IGNIX_LAUNCH_URL, deployed } from '@/lib/config';
import { useFilters } from '@/lib/hooks';
import type { Row } from '@/lib/ignix';
import { NotDeployed } from './NotDeployed';

const SIZES = [15, 30, 45, 60, 0] as const; // 0 = all
const CHUNK = 250; // tokens per LatchGate.checkMany call

function TokenMark({ r }: { r: Row }) {
  const [broken, setBroken] = useState(false);
  return (
    <span className="tokenmark" aria-hidden>
      <i>{r.s.slice(0, 2).toUpperCase()}</i>
      {r.i && !broken && <img src={r.i} alt="" loading="lazy" onError={() => setBroken(true)} />}
    </span>
  );
}

export function LaunchList({ initial, total }: { initial: Row[]; total: number }) {
  const [rows, setRows] = useState<Row[]>(initial);
  const [full, setFull] = useState(false);
  const [size, setSize] = useState<number>(15);
  const [q, setQ] = useState('');
  const { filters } = useFilters();
  const [filterId, setFilterId] = useState<number | null>(null);
  const active = filterId ?? filters[0]?.id ?? null;

  // The server sends the top 60; the full index loads when someone asks for more (All) or searches.
  const needFull = size === 0 || q.trim() !== '';
  useEffect(() => {
    if (!needFull || full) return;
    let stop = false;
    fetch('/api/launches')
      .then((r) => r.json())
      .then((j: { rows?: Row[] }) => { if (!stop && j.rows) { setRows(j.rows); setFull(true); } })
      .catch(() => {});
    return () => { stop = true; };
  }, [needFull, full]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? rows.filter((r) => r.s.toLowerCase().includes(s) || r.n.toLowerCase().includes(s) || r.t.includes(s)) : rows;
  }, [rows, q]);
  const visible = size === 0 ? filtered : filtered.slice(0, size);

  const chunks = useMemo(() => {
    const out: `0x${string}`[][] = [];
    for (let i = 0; i < visible.length; i += CHUNK) out.push(visible.slice(i, i + CHUNK).map((r) => r.t));
    return out;
  }, [visible]);
  const checks = useReadContracts({
    contracts: chunks.map((tokens) => ({ address: DEPLOYMENT.gate!, abi: gateAbi, functionName: 'checkMany' as const, args: [tokens, BigInt(active ?? 0)] as const })),
    query: { enabled: deployed && active !== null && chunks.length > 0 },
  });
  const state = useMemo(() => {
    const m = new Map<string, { pass: boolean; word: number }>();
    (checks.data ?? []).forEach((res, ci) => {
      if (res.status !== 'success') return;
      const [passes, ins] = res.result;
      chunks[ci].forEach((t, k) => m.set(t, { pass: passes[k], word: ins[k] }));
    });
    return m;
  }, [checks.data, chunks]);
  const failed = checks.data?.find((r) => r.status === 'failure');

  return (
    <>
      <div className="toolbar">
        <div className="left">
          <span className="section-label" style={{ margin: 0 }}>Launches</span>
          <div className="seg" role="tablist" aria-label="Rows to show">
            {SIZES.map((n) => (
              <button key={n} role="tab" aria-selected={size === n} className={size === n ? 'on' : ''} onClick={() => setSize(n)}>
                {n === 0 ? 'All' : n}
              </button>
            ))}
          </div>
          {filters.length > 0 && (
            <select className="pick" value={active ?? ''} onChange={(e) => setFilterId(Number(e.target.value))} aria-label="Filter">
              {filters.map((f) => <option key={f.id} value={f.id}>{f.name}{f.nState ? ' (latch)' : ''}</option>)}
            </select>
          )}
        </div>
        <label className="search" style={{ margin: 0 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input placeholder="Search symbol, name or address" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search launches" />
        </label>
      </div>

      {!deployed && <NotDeployed what="Live latch state per filter" />}
      {failed && <div className="bar warn"><span className="dot amber" />LatchGate read failed: {failed.error?.message.split('\n')[0]}</div>}

      <div className="mkt" role="table" aria-label="Ignix launches">
        <div className="mkt-head" role="row">
          <span>Launch</span>
          <span className="r">Holders</span>
          <span>Stage</span>
          <span>State</span>
          <span>Inputs <span className="muted">(green attested · white on-chain)</span></span>
        </div>
        {visible.map((r) => {
          const st = state.get(r.t);
          return (
            <div className="mkt-row" role="row" key={r.t}>
              <a className="idcell" href={IGNIX_LAUNCH_URL(r.t)} target="_blank" rel="noreferrer" style={{ color: 'inherit', textDecoration: 'none' }}>
                <TokenMark r={r} />
                <span className="t">
                  <span className="sym">{r.s}</span>
                  <span className="name">{r.n}</span>
                </span>
              </a>
              <span className="r num hide-sm">{r.h.toLocaleString()}</span>
              <span className="hide-sm">
                <span className="chip">{r.g ? `Pool · ${r.v}` : 'Curve'}</span>
                {r.a !== null && <div className="muted small" style={{ marginTop: 4 }}>agent #{r.a}{r.r ? ` · $${r.r}` : ''}</div>}
              </span>
              <span>
                {!deployed || !st ? <span className="muted">—</span> : st.pass ? <span className="chip green">Unlatched</span> : <span className="chip amber">Latched</span>}
              </span>
              <span className="bits bits-cell">
                {st ? decode(st.word).map((b) => (
                  <span key={b} title={BIT_LABELS[b]} className={`bit ${isOnchain(b) ? 'chain' : ''} ${b === 'LP_PULLED' ? 'bad' : ''}`}>{b}</span>
                )) : <span className="muted small">{deployed ? '…' : 'after deploy'}</span>}
              </span>
            </div>
          );
        })}
        {visible.length === 0 && <div className="empty">{needFull && !full ? 'Loading the full index…' : 'No launches match.'}</div>}
      </div>
      <div className="list-foot">
        <span>
          Showing {visible.length.toLocaleString()} of {(full ? filtered.length : total).toLocaleString()} launches · graduated,
          agent-linked and most-held first
        </span>
        {size !== 0 && visible.length < filtered.length && (
          <button className="small ghost" onClick={() => setSize(SIZES.find((n) => n > size) ?? 0)}>
            Show {SIZES.find((n) => n > size) ? `${SIZES.find((n) => n > size)}` : 'all'}
          </button>
        )}
      </div>
    </>
  );
}
