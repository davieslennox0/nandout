'use client';

import { formatUnits, type Address } from 'viem';
import { useReadContract, useReadContracts } from 'wagmi';
import { NotDeployed } from '@/components/NotDeployed';
import { erc20Abi, lockAbi } from '@/lib/abi';
import { DEPLOYMENT, EXPLORER, deployed } from '@/lib/config';

export default function TreasuryPage() {
  return (
    <>
      <h1>Treasury</h1>
      <p className="lede">
        Free to check, pay to create. LatchLock charges a fee on each new lock, paid in the locked token to an immutable
        treasury address. Everything it holds is listed here. Fee tokens are not sold in v1.
      </p>
      {!deployed ? <NotDeployed what="Treasury holdings" /> : <Holdings />}
    </>
  );
}

function Holdings() {
  const treasury = useReadContract({ address: DEPLOYMENT.lock, abi: lockAbi, functionName: 'treasury' });
  const feeBps = useReadContract({ address: DEPLOYMENT.lock, abi: lockAbi, functionName: 'feeBps' });
  const count = useReadContract({ address: DEPLOYMENT.lock, abi: lockAbi, functionName: 'lockCount' });
  const n = Number(count.data ?? 0n);
  const locks = useReadContracts({
    contracts: Array.from({ length: n }, (_, i) => ({ address: DEPLOYMENT.lock!, abi: lockAbi, functionName: 'getLock' as const, args: [BigInt(i + 1)] as const })),
    query: { enabled: n > 0 },
  });
  const tokens = [...new Set((locks.data ?? []).flatMap((r) => (r.status === 'success' ? [r.result[0].token] : [])))] as Address[];
  const t = treasury.data;
  const bals = useReadContracts({
    contracts: tokens.flatMap((tok) => [
      { address: tok, abi: erc20Abi, functionName: 'symbol' as const },
      { address: tok, abi: erc20Abi, functionName: 'decimals' as const },
      { address: tok, abi: erc20Abi, functionName: 'balanceOf' as const, args: [t!] as const },
    ]),
    query: { enabled: Boolean(t) && tokens.length > 0 },
  });
  return (
    <>
      <div className="stats">
        <div><b>{feeBps.data !== undefined ? `${feeBps.data / 100}%` : '…'}</b><span>lock fee (immutable)</span></div>
        <div><b>{n}</b><span>locks created</span></div>
        <div><b>{tokens.length}</b><span>tokens held</span></div>
      </div>
      {t && <p className="small">Treasury: <a className="mono" href={`${EXPLORER}/address/${t}`}>{t}</a></p>}
      {n === 0 && !count.isLoading && <div className="card empty" style={{ marginTop: 20 }}>No locks yet, so no fees collected.</div>}
      {tokens.length > 0 && (
        <table>
          <thead><tr><th>Token</th><th>Balance</th></tr></thead>
          <tbody>
            {tokens.map((tok, i) => {
              const [sym, dec, bal] = [0, 1, 2].map((k) => bals.data?.[i * 3 + k]).map((r) => (r?.status === 'success' ? r.result : undefined));
              return (
                <tr key={tok}>
                  <td><b>{(sym as string) ?? '…'}</b> <a className="mono small" href={`${EXPLORER}/token/${tok}`}>{tok}</a></td>
                  <td className="mono">{bal !== undefined ? formatUnits(bal as bigint, (dec as number) ?? 18) : '…'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}
