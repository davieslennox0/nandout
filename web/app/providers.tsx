'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { WagmiProvider, createConfig, http } from 'wagmi';
import { xLayer } from 'wagmi/chains';
import { injected } from 'wagmi/connectors';
import { RPC } from '@/lib/config';

export const wagmiConfig = createConfig({
  chains: [xLayer],
  connectors: [injected()],
  transports: { [xLayer.id]: http(RPC, { batch: true }) },
  ssr: true,
});

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 15_000 } } }));
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
