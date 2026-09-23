'use client';

import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi';
import { xLayer } from 'wagmi/chains';

export const short = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

export function Wallet() {
  const { address, chainId, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();

  if (!isConnected) {
    const c = connectors[0];
    return (
      <button className="btn" disabled={!c || isPending} onClick={() => c && connect({ connector: c, chainId: xLayer.id })}>
        {isPending ? 'Connecting…' : 'Connect wallet'}
      </button>
    );
  }
  if (chainId !== xLayer.id) {
    return (
      <button className="btn warn" onClick={() => switchChain({ chainId: xLayer.id })}>
        Switch to X Layer
      </button>
    );
  }
  return (
    <button className="btn ghost mono" title="Disconnect" onClick={() => disconnect()}>
      {short(address)}
    </button>
  );
}
