import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Nav } from '@/components/Nav';
import './globals.css';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: 'Nandout: nothing moves on Ignix until the logic says so',
  description:
    'Taped-out TapeOut logic circuits that gate Ignix launches and lock creator allocations on X Layer.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <Nav />
          <main>{children}</main>
          <footer>
            Nandout · circuits on <a href="https://tapeout.net">TapeOut</a> · launches from{' '}
            <a href="https://ignix.bot">Ignix</a> · X Layer (196). Contracts keep the <code>Latch*</code> names: latch is
            the mechanism, Nandout is the product.
          </footer>
        </Providers>
      </body>
    </html>
  );
}
