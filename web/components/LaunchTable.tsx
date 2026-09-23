'use client';

import { useMemo, useState } from 'react';
import { useReadContract } from 'wagmi';
import { gateAbi } from '@/lib/abi';
import { BIT_LABELS, decode, isOnchain } from '@/lib/bits';
import { DEPLOYMENT, IGNIX_LAUNCH_URL, deployed } from '@/lib/config';
import { useFilters } from '@/lib/hooks';
import { NotDeployed } from './NotDeployed';
import { short } from './Wallet';

interface Row {
  tokenAddress: `0x${string}`;
  symbol: string;
  name: string;
  holders: number;
  graduated: boolean;
  venue: string;
  asp: { id: number; rev: number | null } | null;
  createdTime: string;
}

const PAGE = 50;

export function LaunchTable({ launches, total }: { launches: Row[]; total: number }) {
  const { filters } = useFilters();
  const [filterId, setFilterId] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const [q, setQ] = useState('');
  const active = filterId ?? filters[0]?.id ?? null;

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? launches.filter((l) => l.symbol.toLowerCase().includes(s) || l.name.toLowerCase().includes(s) || l.tokenAddress.includes(s)) : launches;
  }, [launches, q]);
  const visible = rows.slice(page * PAGE, (page + 1) * PAGE);

  const check = useReadContract({
    address: DEPLOYMENT.gate,
    abi: gateAbi,
    functionName: 'checkMany',
    args: [visible.map((l) => l.tokenAddress), BigInt(active ?? 0)],
    query: { enabled: deployed && active !== null && visible.length > 0 },
  });
  const [passes, ins] = check.data ?? [[], []];

  return (
    <>
      {!deployed && <NotDeployed what="Live latch state per filter" />}
      <div className="row" style={{ margin: '1rem 0' }}>
        <input placeholder="Search symbol, name or address" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} style={{ maxWidth: 320 }} />
        {filters.length > 0 && (
          <select value={active ?? ''} onChange={(e) => setFilterId(Number(e.target.value))} style={{ maxWidth: 260 }}>
            {filters.map((f) => (
              <option key={f.id} value={f.id}>
                #{f.id} {f.name}
                {f.nState ? ' (latch)' : ''}
              </option>
            ))}
          </select>
        )}
        <span className="muted small">
          Showing the {launches.length} highest-signal of {total.toLocaleString()} launches (graduated, agent-linked, most holders first).
        </span>
      </div>
      {check.error && <div className="empty error">LatchGate read failed: {check.error.message.split('\n')[0]}</div>}
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Launch</th>
              <th>Holders</th>
              <th>Stage</th>
              <th>State</th>
              <th>Inputs (solid = attested, dashed = on-chain)</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((l, i) => {
              const pass = passes[i];
              const word = ins[i];
              return (
                <tr key={l.tokenAddress}>
                  <td>
                    <a href={IGNIX_LAUNCH_URL(l.tokenAddress)} target="_blank" rel="noreferrer">
                      <b>{l.symbol}</b>
                    </a>{' '}
                    <span className="muted small">{l.name}</span>
                    <div className="mono muted small">{short(l.tokenAddress)}</div>
                  </td>
                  <td className="mono">{l.holders}</td>
                  <td className="small">
                    {l.graduated ? `pool (${l.venue})` : 'curve'}
                    {l.asp && <div className="muted">agent #{l.asp.id}{l.asp.rev ? ` · $${l.asp.rev}` : ''}</div>}
                  </td>
                  <td>
                    {!deployed || pass === undefined ? (
                      <span className="muted">—</span>
                    ) : pass ? (
                      <span className="state-unlatched">unlatched</span>
                    ) : (
                      <span className="state-latched">latched</span>
                    )}
                  </td>
                  <td>
                    {word === undefined
                      ? <span className="muted">—</span>
                      : decode(word).map((b) => (
                          <span key={b} title={BIT_LABELS[b]} className={`pill on ${isOnchain(b) ? 'chain' : ''} ${b === 'LP_PULLED' ? 'bad' : ''}`}>
                            {b}
                          </span>
                        ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="row" style={{ marginTop: '1rem' }}>
        <button className="btn ghost small" disabled={page === 0} onClick={() => setPage(page - 1)}>← Prev</button>
        <span className="muted small">Page {page + 1} of {Math.max(1, Math.ceil(rows.length / PAGE))}</span>
        <button className="btn ghost small" disabled={(page + 1) * PAGE >= rows.length} onClick={() => setPage(page + 1)}>Next →</button>
      </div>
    </>
  );
}
