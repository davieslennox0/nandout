import { LaunchTable } from '@/components/LaunchTable';
import { fetchLaunches, rank } from '@/lib/ignix';

export const revalidate = 60;

export default async function LaunchesPage() {
  let launches;
  try {
    launches = rank(await fetchLaunches());
  } catch (e) {
    return (
      <>
        <h1>Launches</h1>
        <div className="empty error">Could not load the Ignix launch index: {(e as Error).message}</div>
      </>
    );
  }
  const graduated = launches.filter((l) => l.graduated).length;
  const linked = launches.filter((l) => l.asp).length;
  const withHolders = launches.filter((l) => l.holders >= 100).length;

  return (
    <>
      <h1>Nothing moves on Ignix until the logic says so.</h1>
      <p className="lede">
        Every Ignix launch starts <span className="state-latched">latched</span>. It is{' '}
        <span className="state-unlatched">unlatched</span> only when a taped-out TapeOut circuit says so. Vaults, agents
        and traders read the same answer on-chain, for free.
      </p>
      <div className="stats">
        <div className="stat"><b>{launches.length.toLocaleString()}</b><span>Ignix launches</span></div>
        <div className="stat"><b>{graduated}</b><span>graduated to a pool</span></div>
        <div className="stat"><b>{linked}</b><span>linked to an OKX.AI agent</span></div>
        <div className="stat"><b>{withHolders}</b><span>with ≥ 100 holders</span></div>
      </div>
      <LaunchTable launches={launches.slice(0, 400).map(({ tokenAddress, symbol, name, holders, graduated, venue, asp, createdTime }) => ({ tokenAddress, symbol, name, holders, graduated, venue, asp, createdTime }))} total={launches.length} />
    </>
  );
}
