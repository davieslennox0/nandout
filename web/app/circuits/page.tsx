'use client';

import { useEffect, useState } from 'react';
import { usePublicClient } from 'wagmi';
import { NotDeployed } from '@/components/NotDeployed';
import { short } from '@/components/Wallet';
import { gateAbi } from '@/lib/abi';
import { DEPLOYMENT, EXPLORER, deployed } from '@/lib/config';
import { useFilters, type FilterInfo } from '@/lib/hooks';

export default function CircuitsPage() {
  const { filters, isLoading, error } = useFilters();
  const unlatched = useUnlatchedCounts(filters);
  return (
    <>
      <h1>Circuits</h1>
      <p className="lede">
        Every filter and unlock circuit registered on LatchGate. Each one is a taped-out TapeOut circuit (an NFT holding a
        real gate-level netlist) plus the immutable snapshot LatchEvaluator runs. Anyone can register one from{' '}
        <a href="/build">Build</a>; no admin approves them.
      </p>
      {!deployed && <NotDeployed what="The circuit registry" />}
      {error && <div className="empty error">{error.message.split('\n')[0]}</div>}
      {deployed && !isLoading && filters.length === 0 && <div className="empty">No filters registered yet.</div>}
      {filters.length > 0 && (
        <div className="scroll">
          <table>
            <thead>
              <tr><th>#</th><th>Name</th><th>Kind</th><th>Transistors</th><th>Unlatched now</th><th>TapeOut circuit</th><th>Registrant</th></tr>
            </thead>
            <tbody>
              {filters.map((f) => (
                <tr key={f.id}>
                  <td className="mono">{f.id}</td>
                  <td><b>{f.name}</b><div className="mono muted small" title={f.netlistHash}>{f.netlistHash.slice(0, 18)}…</div></td>
                  <td>{f.nState ? 'latch (sticky)' : 'combinational'}</td>
                  <td className="mono">{f.gateCount}</td>
                  <td className="mono">{unlatched[f.id] ?? '…'}</td>
                  <td className="mono small"><a href={`${EXPLORER}/address/${f.cpu}`}>{short(f.cpu)}</a> #{f.circuitId.toString()}</td>
                  <td className="mono small"><a href={`${EXPLORER}/address/${f.registrant}`}>{short(f.registrant)}</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {deployed && <p className="muted small">&ldquo;Unlatched now&rdquo; = Ignix launches this filter passes right now, via <code>LatchGate.checkMany</code>.</p>}
    </>
  );
}

function useUnlatchedCounts(filters: FilterInfo[]) {
  const pub = usePublicClient();
  const [counts, setCounts] = useState<Record<number, number | string>>({});
  useEffect(() => {
    if (!pub || !DEPLOYMENT.gate || filters.length === 0) return;
    let stop = false;
    (async () => {
      const r = await fetch('/api/launches');
      if (!r.ok) return;
      const { tokens } = (await r.json()) as { tokens: `0x${string}`[] };
      for (const f of filters) {
        let n = 0;
        try {
          for (let i = 0; i < tokens.length && !stop; i += 250) {
            const [passes] = await pub.readContract({ address: DEPLOYMENT.gate!, abi: gateAbi, functionName: 'checkMany', args: [tokens.slice(i, i + 250), BigInt(f.id)] });
            n += passes.filter(Boolean).length;
          }
          if (!stop) setCounts((c) => ({ ...c, [f.id]: n }));
        } catch {
          if (!stop) setCounts((c) => ({ ...c, [f.id]: 'feed stale' }));
        }
      }
    })();
    return () => { stop = true; };
  }, [pub, filters]);
  return counts;
}
