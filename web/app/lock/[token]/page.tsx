import type { Metadata } from 'next';
import Link from 'next/link';
import { formatUnits, type Address } from 'viem';
import { BITS } from '@latch/compiler';
import { Countdown } from '@/components/Countdown';
import { ShareSnippets } from '@/components/ShareSnippets';
import { BIT_LABELS, BIT_NAMES, isOnchain } from '@/lib/bits';
import { DEPLOYMENT, deployed, EXPLORER, IGNIX_LAUNCH_URL, NANDOUT_DEPLOY_WALLET } from '@/lib/config';
import { fmtDuration, has, secondsUntil, type Explained } from '@/lib/explain';
import { explainFilter, pctOf, summarize, trancheStatus, type Summary } from '@/lib/lockstatus';
import { ignixStatus, parseToken, readToken, type TokenView } from '@/lib/lockview';

export const revalidate = 30;

const SITE = 'https://nandout.xyz';
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const fmt = (v: bigint, d: number) => Number(formatUnits(v, d)).toLocaleString('en-US', { maximumFractionDigits: 2 });
const utc = (t: number) => new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

async function load(raw: string): Promise<{ token: Address | null; v: TokenView | null; error?: string }> {
  const token = parseToken(raw);
  if (!token || !deployed) return { token, v: null };
  try {
    return { token, v: await readToken(token) };
  } catch (e) {
    return { token, v: null, error: (e as Error).message.split('\n')[0] };
  }
}

function headline(v: TokenView, s: Summary) {
  const sym = v.symbol ? `$${v.symbol}` : short(v.token);
  if (s.state === 'LOCKED') return `${sym}: ${s.pct}% of supply locked by the creator`;
  if (s.state === 'NOT LOCKED') return `${sym}: creator allocation not locked`;
  return `${sym}: not an attested Ignix launch`;
}

export async function generateMetadata({ params }: { params: { token: string } }): Promise<Metadata> {
  const { token, v } = await load(params.token);
  if (!token || !v) {
    return { title: 'Lock status · Nandout', description: 'Check whether a token launched on Ignix has its creator allocation locked behind on-chain unlock circuits.' };
  }
  const s = summarize(v);
  const title = headline(v, s);
  const description =
    s.state === 'LOCKED'
      ? `${fmt(v.creatorLocked, v.decimals)} tokens held by LatchLock; released only when unlock circuits pass. Read at X Layer block ${v.block}.`
      : s.state === 'NOT LOCKED'
        ? `The creator has ${s.pct}% of supply in LatchLock; ${s.thresholdPct}% is needed for LATCH_LOCKED. Read at X Layer block ${v.block}.`
        : 'This address is not registered in the Nandout feed.';
  const image = `${SITE}/badge/${token}.png`;
  return {
    title: `${title} · Nandout`,
    description,
    openGraph: { title, description, url: `${SITE}/lock/${token}`, siteName: 'Nandout', images: [{ url: image, width: 600, height: 120 }] },
    twitter: { card: 'summary', title, description, images: [image] },
  };
}

export default async function LockStatusPage({ params, searchParams }: { params: { token: string }; searchParams: { created?: string } }) {
  const { token, v, error } = await load(params.token);
  if (!token) return <Empty reason={`“${decodeURIComponent(params.token).slice(0, 64)}” is not a token address.`} />;
  if (!deployed) return <Empty reason="Contracts are not configured on this deployment." token={token} />;
  if (!v) return <Empty reason={`Could not read X Layer right now (${error}). Try again in a minute.`} token={token} />;
  if (!v.known) return <Empty reason="This address is not registered in the Nandout feed, so it has no attested state and no lock status. Nandout attests tokens launched on Ignix." token={token} v={v} />;

  const s = summarize(v);
  const sym = v.symbol ?? '?';
  const curve = await ignixStatus(v.token);
  const d = v.decimals;
  const inputs = v.inputs ?? 0;
  const combinational = v.filters.filter((f) => !f.stateful);

  return (
    <>
      <span className="eyebrow">Lock status · launched on Ignix</span>
      {v.locks.some((l) => l.depositor.toLowerCase() === NANDOUT_DEPLOY_WALLET.toLowerCase()) && (
        <div className="bar warn" style={{ marginBottom: 16 }}>
          <span className="dot amber" />
          <span>
            <b>This token has Nandout&apos;s own test lock.</b> We bought this token once and locked part of it to exercise the lock path
            end to end. It is not a creator lock, and it does not turn on LATCH_LOCKED, because we are not this token&apos;s creator.
            {' '}<a href="/hook">Details</a>
          </span>
        </div>
      )}
      <h1>{v.name ?? sym} <span className="muted">${sym}</span></h1>
      <p className="mono small muted" style={{ marginTop: 10, wordBreak: 'break-all' }}>
        {v.token} · <a href={IGNIX_LAUNCH_URL(v.token)}>launch page</a> · <a href={`${EXPLORER}/token/${v.token}`}>OKLink</a>
      </p>
      <Snapshot v={v} />

      <div className={`card ${s.state === 'LOCKED' ? 'green' : ''}`} style={{ marginTop: 20 }}>
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <span className={`chip ${s.state === 'LOCKED' ? 'green' : 'amber'}`} style={{ fontSize: 14 }}>{s.state}</span>
          <span className="muted small">
            LATCH_LOCKED needs the creator to keep ≥ {s.thresholdPct}% of total supply in LatchLock
          </span>
        </div>
        <div className="big" style={{ marginTop: 14 }}>{s.pct}% <span className="muted" style={{ fontSize: 16, fontWeight: 400 }}>of supply locked by the creator</span></div>
        <div className="kv">
          <div><span>Creator (as recorded for this launch)</span><b className="mono"><a href={`${EXPLORER}/address/${v.creator}`}>{v.creator}</a></b></div>
          <div><span>Still locked by the creator</span><b>{fmt(v.creatorLocked, d)} {sym}</b></div>
          <div><span>Total supply</span><b>{v.totalSupply !== null ? `${fmt(v.totalSupply, d)} ${sym}` : 'unreadable'}</b></div>
          <div>
            <span>Clears the {s.thresholdPct}% threshold?</span>
            <b className={v.latchLocked ? 'unlatched' : 'latched'}>
              {v.latchLocked
                ? `Yes: ${s.pct}% ≥ ${s.thresholdPct}%, so LATCH_LOCKED is on`
                : v.creatorLocked > 0n
                  ? `No: ${s.pct}% < ${s.thresholdPct}%, so LATCH_LOCKED is off`
                  : 'No: the creator has nothing in LatchLock, so LATCH_LOCKED is off'}
            </b>
          </div>
          {s.state === 'LOCKED' && (
            <div>
              <span>Next unlock</span>
              <b>{s.nextUnlock === 0 ? 'a tranche can be released now' : s.nextUnlock !== null ? <>in <Countdown to={v.blockTime + s.nextUnlock} /> (if nothing else changes)</> : 'when its circuit conditions are met (not time-based)'}</b>
            </div>
          )}
        </div>
        <p className="small muted" style={{ marginTop: 12 }}>
          Releases are evaluated by <a href={`${EXPLORER}/address/${DEPLOYMENT.evaluator}`}>LatchEvaluator</a> (
          <span className="mono">{DEPLOYMENT.evaluator && short(DEPLOYMENT.evaluator)}</span>), which is immutable and has no owner. Once a lock
          exists, neither the creator nor Nandout can change its tranches, circuits or beneficiary, pause it, or take the tokens back.
          Released tokens go only to the beneficiary. The attested inputs (LP, holders, revenue, dev outflows) come from Nandout&apos;s
          attestor; the circuits that judge them cannot be changed.
        </p>
      </div>

      <div className="section-label">
        Locks<span>{v.locks.length} on LatchLock for this token · only the creator&apos;s own locks count toward LATCH_LOCKED</span>
      </div>
      {v.locks.length === 0 && (
        <div className="card empty">
          Nothing is locked for ${sym}.{' '}
          {curve.graduated === false
            ? <>It is still on its Ignix bonding curve{curve.progress !== null ? ` (${Math.round(curve.progress * 100)}%)` : ''}, and Ignix tokens cannot be transferred until they graduate, so it cannot be locked yet.</>
            : <>The creator wallet can lock tokens from <Link href="/lock">/lock</Link>; locking ≥ {s.thresholdPct}% of supply turns on LATCH_LOCKED.</>}{' '}
          <Link href="/creators">What locking proves</Link>.
        </div>
      )}
      {[...s.creatorLocks, ...s.otherLocks].map((l) => (
        <div className="card" key={String(l.id)}>
          <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <h3 style={{ margin: 0 }}>Lock #{String(l.id)}</h3>
            <span className={`chip ${s.creatorLocks.includes(l) ? 'accent' : l.depositor.toLowerCase() === NANDOUT_DEPLOY_WALLET.toLowerCase() ? 'amber' : ''}`}>
              {s.creatorLocks.includes(l)
                ? 'deposited by the creator'
                : l.depositor.toLowerCase() === NANDOUT_DEPLOY_WALLET.toLowerCase()
                  ? "Nandout's own test lock: not from the creator, does not count"
                  : 'not from the creator wallet: does not count'}
            </span>
          </div>
          <div className="kv">
            <div><span>Beneficiary</span><b className="mono"><a href={`${EXPLORER}/address/${l.beneficiary}`}>{l.beneficiary}</a></b></div>
            <div><span>Depositor</span><b className="mono">{short(l.depositor)}</b></div>
            <div><span>Created</span><b>{utc(l.createdAt)}</b></div>
            <div><span>Locked / released</span><b>{fmt(l.amount - l.released, d)} / {fmt(l.released, d)} {sym} ({pctOf(l.amount, v.totalSupply)}% of supply at creation)</b></div>
          </div>
          <div className="tranches">
            {l.tranches.map((t, i) => {
              const ts = trancheStatus(v, l, i);
              const f = ts.filter;
              return (
                <div className="tranche" key={i}>
                  <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                    <b>Tranche {i + 1} · {t.bps / 100}%</b>
                    {t.released ? <span className="chip">released</span> : <PassChip chain={ts.chain} ex={ts.ex} />}
                  </div>
                  <p className="small muted" style={{ margin: '6px 0' }}>
                    Unlock circuit <b>{f?.name ?? `#${t.filterId}`}</b> · filter #{t.filterId} · TapeOut circuit #{f ? String(f.circuitId) : '?'} ·{' '}
                    {fmt(t.amount, d)} {sym} {t.released ? 'released' : 'locked'}
                  </p>
                  {!t.released && <Reasons ex={ts.ex} v={v} />}
                  {!t.released && ts.eta !== null && ts.eta > 0 && <p className="small">Time-only: releasable in <Countdown to={v.blockTime + ts.eta} /> if nothing else changes.</p>}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <div className="section-label">Filters<span>live <code>LatchGate.check</code> at block {String(v.block)}, with the conditions behind each result</span></div>
      <div className="grid g2">
        {v.filters.map((f) => {
          const ex = explainFilter(f, inputs, v.prevPass[f.id] ?? 0);
          return (
            <div className="card" key={f.id}>
              <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                <h3 style={{ margin: 0 }}>{f.name}</h3>
                <PassChip chain={v.checks[f.id]} ex={ex} stateful={f.stateful} />
              </div>
              <p className="small muted" style={{ margin: '6px 0' }}>
                filter #{f.id} · TapeOut #{String(f.circuitId)} · {f.gateCount} gates{f.stateful ? ' · stateful (latch)' : ''}
                {!f.circuit && ' · third-party netlist'}
              </p>
              <Reasons ex={ex} v={v} />
            </div>
          );
        })}
      </div>
      {combinational.length < v.filters.length && (
        <p className="small muted">Stateful (latch) filters remember earlier snapshots, so they can pass on history. LatchLock never accepts them as unlock circuits.</p>
      )}

      <div className="section-label">Inputs<span>the 16-bit word every circuit reads: 0x{inputs.toString(16).padStart(4, '0')}</span></div>
      <div className="card">
        <table>
          <thead><tr><th>Bit</th><th>Condition</th><th>Source</th><th>Now</th></tr></thead>
          <tbody>
            {BIT_NAMES.map((b) => {
              const on = has(inputs, b);
              const wait = !on ? secondsUntil(b, v.launchTime, v.blockTime) : 0;
              return (
                <tr key={b}>
                  <td className="mono">{BITS[b]} {b}</td>
                  <td>{BIT_LABELS[b]}</td>
                  <td className="muted small">{isOnchain(b) ? 'computed on-chain' : `attested ${v.updatedAt ? utc(v.updatedAt) : '—'}`}</td>
                  <td>
                    <span className={b === 'LP_PULLED' ? (on ? 'latched' : 'muted') : on ? 'unlatched' : 'muted'}>{on ? 'on' : 'off'}</span>
                    {wait > 0 && <span className="muted small"> · in {fmtDuration(wait)}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ShareSnippets token={v.token} symbol={sym} fresh={searchParams.created !== undefined} />
    </>
  );
}

function Snapshot({ v }: { v: TokenView }) {
  return (
    <div className={`bar ${v.fresh ? 'live' : 'warn'}`}>
      <span className={`dot ${v.fresh ? '' : 'amber'}`} />
      Read from X Layer at block {String(v.block)} ({utc(v.blockTime)}).{' '}
      {v.fresh
        ? `Feed fresh: last attestor heartbeat ${utc(v.lastHeartbeat)}.`
        : `Feed stale since ${v.lastHeartbeat ? utc(v.lastHeartbeat) : 'never'}: combinational checks and releases revert until the attestor posts again.`}
    </div>
  );
}

function PassChip({ chain, ex, stateful }: { chain: TokenView['checks'][number] | undefined; ex: Explained | null; stateful?: boolean }) {
  if (!chain) return <span className="chip">not checked</span>;
  if ('error' in chain) return <span className="chip amber">{chain.error === 'FeedStale' ? 'feed stale: no answer' : `check ${chain.error}`}</span>;
  const disagree = ex && ex.pass !== chain.pass;
  return (
    <span className={`chip ${chain.pass ? 'green' : 'amber'}`} title={disagree ? 'The on-chain result differs from the reference rule; the chain result is authoritative.' : undefined}>
      {chain.pass ? 'passes' : stateful ? 'latched' : 'fails'}{disagree ? ' · differs from rule' : ''}
    </span>
  );
}

function Reasons({ ex, v }: { ex: Explained | null; v: TokenView }) {
  if (!ex) return <p className="small muted">Reasons unavailable: the circuit&apos;s netlist could not be read.</p>;
  const lead = { unmet: 'Not met:', met: 'Passes on:', reset: 'Reset by:', held: '', netlist: 'Netlist sensitivity:' }[ex.kind];
  return (
    <ul className="reasons">
      {ex.why.map((r, i) => {
        const wait = secondsUntil(r.bit, v.launchTime, v.blockTime);
        return (
          <li key={i} className={ex.kind === 'unmet' || ex.kind === 'reset' ? 'no' : 'yes'}>
            {i === 0 && lead && <span className="muted">{lead} </span>}
            {r.text}
            {ex.kind === 'unmet' && wait > 0 && <span className="muted"> · in <Countdown to={v.blockTime + wait} /></span>}
          </li>
        );
      })}
    </ul>
  );
}

function Empty({ reason, token, v }: { reason: string; token?: Address; v?: TokenView }) {
  return (
    <>
      <span className="eyebrow">Lock status</span>
      <h1>{v?.symbol ? `$${v.symbol}` : token ? short(token) : 'No token'}</h1>
      {token && <p className="mono small muted" style={{ marginTop: 10, wordBreak: 'break-all' }}>{token} · <a href={`${EXPLORER}/token/${token}`}>OKLink</a></p>}
      {v && <Snapshot v={v} />}
      <div className="card empty" style={{ marginTop: 20 }}>{reason}</div>
      <div className="steps" style={{ marginTop: 20 }}>
        <div className="card">
          <div className="step-n">What a lock is</div>
          <p>A creator deposits part of their allocation into LatchLock. Each tranche is released only when its unlock circuit (a taped-out NAND netlist) passes, and only to the beneficiary.</p>
        </div>
        <div className="card">
          <div className="step-n">Why it matters</div>
          <p>If the creator keeps ≥ 5% of supply locked, the on-chain LATCH_LOCKED bit turns on, which stricter filters such as STRICT reward. Nobody can edit a lock after it is created.</p>
        </div>
        <div className="card">
          <div className="step-n">Next</div>
          <p><Link href="/lock">Create a lock</Link> · <Link href="/creators">What locking proves</Link> · <Link href="/">Browse launches</Link></p>
        </div>
      </div>
    </>
  );
}
