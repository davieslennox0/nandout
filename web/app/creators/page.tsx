import Link from 'next/link';
import { lockAbi } from '@/lib/abi';
import { DEPLOYMENT, deployed, EXPLORER } from '@/lib/config';
import { client } from '@/lib/lockview';

export const revalidate = 300;
export const metadata = {
  title: 'For creators · Nandout',
  description: 'What locking a creator allocation on Nandout proves, what it costs, and what you can no longer do afterwards.',
};

async function params() {
  if (!deployed) return null;
  try {
    const [feeBps, minLockBps, block] = await Promise.all([
      client.readContract({ address: DEPLOYMENT.lock!, abi: lockAbi, functionName: 'feeBps' }),
      client.readContract({ address: DEPLOYMENT.lock!, abi: lockAbi, functionName: 'minLockBps' }),
      client.getBlockNumber(),
    ]);
    return { fee: Number(feeBps) / 100, min: Number(minLockBps) / 100, block };
  } catch {
    return null;
  }
}

export default async function CreatorsPage() {
  const p = await params();
  const fee = p ? `${p.fee}%` : 'the on-chain fee';
  const min = p ? `${p.min}%` : 'the minimum share';
  const link = (a: string | undefined, name: string) => (a ? <a href={`${EXPLORER}/address/${a}`}>{name}</a> : name);
  return (
    <>
      <span className="eyebrow">For creators</span>
      <h1>Lock your allocation behind logic, not a promise.</h1>
      <p className="lede">
        If you launched a token on Ignix and still hold part of its supply, you can put it in LatchLock. It comes back to you
        (or whoever you name) in tranches, and each tranche only when a public unlock circuit says the launch has earned it.
      </p>
      {p && <p className="small muted">Fee and threshold read from LatchLock at X Layer block {String(p.block)}.</p>}

      <div className="grid g2" style={{ marginTop: 24 }}>
        <div className="card">
          <h3>What it proves</h3>
          <p>
            That you cannot sell the locked tokens until conditions anyone can read are true: for example “7 days old, LP locked,
            100+ holders”. If you keep at least {min} of total supply locked from the creator wallet, the on-chain
            <code> LATCH_LOCKED</code> bit turns on for your token, and filters such as STRICT count it.
          </p>
        </div>
        <div className="card">
          <h3>What it costs</h3>
          <p>
            {fee} of the deposited amount, taken in your token and sent to the Nandout treasury, plus X Layer gas for an approve
            and a createLock (and later one release per tranche). No subscription, nothing else. Lock 10,000,000 and 
            {p ? ` ${(10_000_000 * (1 - p.fee / 100)).toLocaleString('en-US')} are locked, ${(10_000_000 * p.fee / 100).toLocaleString('en-US')} go to the fee.` : ' the fee comes off that amount.'}
          </p>
        </div>
        <div className="card">
          <h3>What you can&apos;t do afterwards</h3>
          <p>
            Withdraw early, change a tranche, swap its circuit, change the beneficiary, or cancel. Nobody can: LatchLock has no admin
            path over locks, and releases are evaluated by {link(DEPLOYMENT.evaluator, 'LatchEvaluator')}, which is immutable and ownerless.
            If an unlock condition never becomes true, that tranche stays locked.
          </p>
        </div>
        <div className="card">
          <h3>What buyers can check</h3>
          <p>
            Your token&apos;s page at <code>nandout.xyz/lock/&lt;token&gt;</code>: amount and share of supply locked, each tranche&apos;s
            circuit and which conditions are still unmet, the beneficiary, and a badge you can post anywhere. All of it is read from
            chain, and anyone can verify it on OKLink without trusting this site.
          </p>
        </div>
      </div>

      <div className="section-label">Before you lock</div>
      <div className="card">
        <ul className="reasons">
          <li className="no">Only the wallet Ignix recorded as your launch&apos;s creator can earn LATCH_LOCKED. A lock from any other wallet is still binding, but does not set the bit.</li>
          <li className="no">Most Ignix creators hold little or none of their token in the creator wallet. If that is you, there is nothing meaningful to lock, and the lock page will say so.</li>
          <li className="no">Conditions like LP locked, holder counts and revenue come from Nandout&apos;s attestor. Releases need a fresh feed; if the attestor stops, releases wait until it posts again. Your tokens are never at risk from that, only delayed.</li>
          <li className="no">Unlock circuits must be stateless. Latch (sticky) filters are rejected by the contract.</li>
          <li className="yes">Release is permissionless: anyone can trigger a passing tranche, and it always pays the beneficiary only.</li>
        </ul>
      </div>

      <div className="section-label">Contracts<span>X Layer mainnet, verified on OKLink</span></div>
      <div className="card">
        <div className="kv">
          <div><span>LatchLock: holds locks, takes the fee</span><b className="mono">{link(DEPLOYMENT.lock, DEPLOYMENT.lock ?? 'not configured')}</b></div>
          <div><span>LatchEvaluator: evaluates releases (immutable, no owner)</span><b className="mono">{link(DEPLOYMENT.evaluator, DEPLOYMENT.evaluator ?? 'not configured')}</b></div>
          <div><span>LatchGate: filter checks and LATCH_LOCKED</span><b className="mono">{link(DEPLOYMENT.gate, DEPLOYMENT.gate ?? 'not configured')}</b></div>
          <div><span>LatchFeed: attested launch facts</span><b className="mono">{link(DEPLOYMENT.feed, DEPLOYMENT.feed ?? 'not configured')}</b></div>
        </div>
      </div>
      <div className="cta">
        <Link href="/lock" className="btn primary">Lock an allocation</Link>
        <Link href="/docs" className="btn ghost">How the contracts fit together</Link>
      </div>
    </>
  );
}
