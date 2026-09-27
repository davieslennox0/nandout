import { compile, STARTERS } from '@latch/compiler';
import Link from 'next/link';
import { LaunchList } from '@/components/LaunchList';
import { deployed } from '@/lib/config';
import { fetchLaunches, rank, toRow } from '@/lib/ignix';
import { outsideRows, readRegistry } from '@/lib/registry';

export const revalidate = 60;

/** Approved processor price (docs/ECONOMICS.md): fixed at deploy. */
const OKB_PER_TRANSISTOR = 0.001;
const KIND: Record<string, string> = {
  BASIC_SAFETY: 'Filter', REVENUE_AGENTS: 'Filter', STRICT: 'Filter',
  UNLOCK_T1: 'Unlock', UNLOCK_T2: 'Unlock', STICKY_SAFETY: 'Latch',
};
const circuits = Object.entries(STARTERS).map(([name, dsl]) => compile(name, dsl));

export default async function HomePage() {
  let launches;
  const reg = await readRegistry();
  try {
    launches = rank(await fetchLaunches());
  } catch (e) {
    return (
      <>
        <h1>Nothing moves on Ignix until the logic says so.</h1>
        <div className="bar warn"><span className="dot amber" />Could not load the Ignix launch index: {(e as Error).message}</div>
      </>
    );
  }
  const graduated = launches.filter((l) => l.graduated).length;
  const linked = launches.filter((l) => l.asp).length;
  const holders100 = launches.filter((l) => l.holders >= 100).length;

  return (
    <>
      <span className="eyebrow">{deployed ? 'Live on X Layer' : 'Reading Ignix live · contracts deploying on X Layer'}</span>
      <h1>Nothing moves on Ignix until the logic says so.</h1>
      <p className="lede">
        Every launch starts <span className="latched">latched</span>. It&apos;s <span className="unlatched">unlatched</span> only
        when a taped-out TapeOut circuit says so, and vaults, agents and traders all read the same answer on-chain, for
        free. Creators can lock their allocation behind the same circuits.
      </p>
      <div className="cta">
        <Link href="/build" className="btn primary">Build a filter</Link>
        <Link href="/lock" className="btn ghost">Lock an allocation</Link>
        <Link href="/docs" className="btn ghost">Integrate</Link>
      </div>
      <div className="stats">
        <div><b>{(launches.length + (reg?.outside.length ?? 0)).toLocaleString()}</b><span>Ignix launches attested</span></div>
        <div><b>{graduated}</b><span>graduated to a pool</span></div>
        <div><b>{linked}</b><span>linked to an OKX.AI agent</span></div>
        <div><b>{holders100}</b><span>with 100+ holders</span></div>
      </div>

      <div className="section-label">
        Circuits
        <span>real NAND netlists, verified against all 65,536 inputs · {OKB_PER_TRANSISTOR} OKB per transistor</span>
      </div>
      <div className="topcards">
        {circuits.map((c) => (
          <article className="topcard" key={c.name}>
            <div className="topcard-head">
              <span className="nm">{c.name}</span>
              <span className={`chip ${KIND[c.name] === 'Latch' ? 'accent' : ''}`}>{KIND[c.name] ?? 'Filter'}</span>
            </div>
            <div className="rule">{c.infix}</div>
            <div className="foot">
              <span><b>{c.gateCount}</b> transistors</span>
              <span><b>{(c.gateCount * OKB_PER_TRANSISTOR).toFixed(3)}</b> OKB</span>
              <span><b>~{Math.round(c.estEvalGas.internalCall / 1000)}k</b> gas</span>
            </div>
          </article>
        ))}
      </div>

      <LaunchList
        initial={launches.slice(0, 60).map(toRow)}
        total={launches.length + (reg?.outside.length ?? 0)}
        cycleAt={reg?.cycleAt ?? null}
        outsideCount={reg?.outside.length ?? 0}
      />

      <div className="section-label">How it works</div>
      <div className="steps">
        <div className="card">
          <div className="step-n">1 · Attest</div>
          <h3>Facts about every launch</h3>
          <p>An attestor reads Ignix and X Layer: agent link, revenue, locked LP, holder spread, dev outflows. Age and locked allocations are computed on-chain.</p>
        </div>
        <div className="card">
          <div className="step-n">2 · Circuit</div>
          <h3>Rules as taped-out logic</h3>
          <p>A filter is a TapeOut circuit: a NAND netlist minted as an NFT. Anyone can build one, and it evaluates the same way for everyone, forever.</p>
        </div>
        <div className="card">
          <div className="step-n">3 · Gate &amp; lock</div>
          <h3>Unlatched, or not</h3>
          <p>Vaults call <code>checkMany</code> before deploying capital. Creator allocations release only when an unlock circuit passes, via a sealed evaluator nobody can change.</p>
        </div>
      </div>
    </>
  );
}
