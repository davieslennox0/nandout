import { EXPLORER, NANDOUT_DEPLOY_WALLET } from '@/lib/config';
import { HOOK_V1_DEPRECATED, HOOK_V2, POOL_ID, POSITION_ID, readDemoPool, XCAT } from '@/lib/demopool';

export const revalidate = 120;
export const metadata = {
  title: 'NexusHook · Nandout',
  description: 'A generic Uniswap v4 hook on X Layer whose fee tier and fee destination are immutable TapeOut circuits. Hook fee, demo pool and deprecation disclosed.',
};

const a = (addr: string, label?: string) => <a className="mono" href={`${EXPLORER}/address/${addr}`}>{label ?? addr}</a>;
const tx = (h: string) => <a className="mono" href={`${EXPLORER}/tx/${h}`}>{h.slice(0, 10)}…{h.slice(-4)}</a>;
const pct = (pips: number) => `${(pips / 10_000).toFixed(2)}%`;

export default async function HookPage() {
  let d: Awaited<ReturnType<typeof readDemoPool>> | null = null;
  try { d = await readDemoPool(); } catch { d = null; }
  const outside = d?.swaps?.filter((s) => s.sender) ?? null;
  return (
    <>
      <span className="eyebrow">NexusHook · Uniswap v4 on X Layer</span>
      <h1>Fees decided by circuits, not by an admin.</h1>
      <p className="lede">
        FeeRouteHook is a generic Uniswap v4 hook. Two taped-out circuits pick each swap&apos;s LP fee tier from volatility and depth
        (measured against the pool&apos;s own baseline), and two more pick where a 5 bps route fee goes. Every circuit&apos;s full output
        was computed once at deploy, so a TapeOut upgrade cannot change the fee or its destination. There is no owner and no setter.
      </p>

      <div className="card" style={{ marginTop: 20 }}>
        <div className="kv">
          <div><span>Hook (v2, live)</span><b>{a(HOOK_V2)}</b></div>
          <div><span>LP fee tiers</span><b>0.05% / 0.30% / 0.60% / 1.00%, chosen per swap by VOL_GUARD and DEPTH_GUARD</b></div>
          <div><span>Route fee</span><b>5 bps; all four routes go to the pool&apos;s in-range LPs</b></div>
          <div><span>Hook fee recipient</span><b>{a(NANDOUT_DEPLOY_WALLET)} (Nandout deploy wallet)</b></div>
        </div>
      </div>

      <div className="section-label">Hook fee</div>
      <div className="card">
        <p>
          <b>1000 pips (0.10%), Uniswap v4&apos;s protocol-fee cap, taken with the mechanics of v4-core&apos;s FeeTakingHook:</b> on the
          swap&apos;s unspecified side and on the amount that actually filled (the output of an exact-input swap, the input of an
          exact-output swap), paid to the Nandout deploy wallet. This is a different denomination from v4&apos;s own protocol fee, which is
          always taken from the input. Everything else goes to the pool&apos;s own in-range LPs.
        </p>
        <p>
          Worked example, a 1,000-token exact-input swap in the 0.30% tier: <b>3.000</b> LP fee to in-range LPs, <b>0.996</b> hook fee to
          the Nandout deploy wallet, <b>0.498</b> route fee to in-range LPs (both in the output token); the trader receives <b>994.51</b>.
        </p>
      </div>

      <div className="section-label">Our own demo pool<span>liquidity supplied by us · no swaps by us</span></div>
      <div className="bar warn">
        <span className="dot amber" />
        <span>
          <b>This is Nandout&apos;s own demo pool, not organic activity.</b> We supplied the liquidity and we have made no swaps in it:
          the hackathon rules void self-trading. Tier evidence is read-only (below), a fork of mainnet at this pool&apos;s state, and the
          fork test suite. Any swap listed below was made by someone else.
        </span>
      </div>
      <div className="card" style={{ marginTop: 12 }}>
        <div className="kv">
          <div><span>Pair</span><b>native OKB / XCAT {a(XCAT, 'XCAT')} (a graduated Ignix launch)</b></div>
          <div><span>Pool ID</span><b className="mono" style={{ wordBreak: 'break-all' }}>{POOL_ID}</b></div>
          <div><span>Liquidity</span><b>0.0614 OKB + 1,649,399.07 XCAT at creation, full range; position NFT #{String(POSITION_ID)} owned by {d ? a(d.owner, 'the Nandout deploy wallet') : 'the Nandout deploy wallet'}</b></div>
          <div><span>The XCAT</span><b>bought once on the open market for this demo and our test lock ({tx('0x0c9162c7e84c13afa3df8f6f700eff8a7fa91d8982f10fd058055cd88f13bb0a')}); not traded again</b></div>
          <div><span>Plan</span><b>withdraw the liquidity after judging (Oct 6, 04:00 UTC)</b></div>
          {d && <div><span>Live read-only tier (block {String(d.block)})</span><b>facts {d.facts} → tier {d.tier} → LP fee {pct(d.feePips)}</b></div>}
          {d && <div><span>Position liquidity now</span><b className="mono">{String(d.liquidity)}</b></div>}
        </div>
        <p className="small muted" style={{ marginTop: 12 }}>
          Fork of mainnet at the live pool&apos;s state (swaps on the fork only, then discarded): calm 0.05% → volatile 0.60% →
          volatile and thin 1.00%. Reproduce: <code>XCAT_EVIDENCE=true forge test --mc XcatPoolEvidenceForkTest</code> in <code>hook/</code>.
        </p>
      </div>

      <div className="section-label">Swaps in the demo pool<span>everything the PoolManager has recorded since block 71,815,113</span></div>
      <div className="card">
        {outside === null && <p className="muted">Could not read the swap log right now.</p>}
        {outside !== null && outside.length === 0 && <p className="muted">None yet. We have made no swaps; this list will show any outside usage with its transaction.</p>}
        {outside !== null && outside.length > 0 && (
          <table>
            <thead><tr><th>Block</th><th>Tx</th><th>Swapper (router)</th><th>LP fee applied</th></tr></thead>
            <tbody>
              {outside.map((s) => (
                <tr key={s.tx}><td>{s.block}</td><td>{tx(s.tx)}</td><td>{a(s.sender, `${s.sender.slice(0, 8)}…`)}</td><td>{pct(s.fee)}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="section-label">Our own test lock</div>
      <div className="card">
        <p>
          LatchLock lock #1: 1,666,059.66 XCAT requested, <b>1,657,729.37 XCAT actually locked</b> (after LatchLock&apos;s 0.5% fee), one
          tranche, 100% on UNLOCK_T1, beneficiary the Nandout deploy wallet. <b>LATCH_LOCKED stays off for XCAT</b>, because we are not
          its creator: this tests the lock path, it is not a creator lock. <a href={`/lock/${XCAT.toLowerCase()}`}>Lock page</a>
        </p>
      </div>

      <div className="section-label">Deprecated: v1</div>
      <div className="card">
        <p>
          <b>FeeRouteHook v1 {a(HOOK_V1_DEPRECATED)} is deprecated.</b> It charged the exact-input hook fee in beforeSwap on the amount
          the trader specified, not the amount that filled, so a partially filled swap (price-limited, or running out of in-range
          liquidity) paid the fee on input that never swapped, and very large specified amounts reverted. It stays on-chain because it
          is immutable (no owner, no upgrade path). <b>No pool ever used it.</b> v2 takes the fee in afterSwap on the actual fill;
          regression test <code>test_partialFillPaysHookFeeOnlyOnFilledAmount</code>.
        </p>
      </div>
    </>
  );
}
