import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Nav } from '@/components/Nav';
import './globals.css';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: 'Nandout: nothing moves on Ignix until the logic says so',
  description: 'Taped-out TapeOut logic circuits that gate Ignix launches and lock creator allocations on X Layer.',
  icons: {
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='9' fill='%23f4f6f9'/%3E%3Cpath d='M8 9h7a7 7 0 0 1 0 14H8z' fill='none' stroke='%230a0a0b' stroke-width='2.4'/%3E%3Ccircle cx='24.2' cy='16' r='2.2' fill='none' stroke='%230a0a0b' stroke-width='2.2'/%3E%3C/svg%3E",
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <Nav />
          <main>{children}</main>
          <footer className="site-foot">
            <span>
              Nandout · circuits on <a href="https://tapeout.net">TapeOut</a> · launches from <a href="https://ignix.bot">Ignix</a> · X Layer
            </span>
            <span>Contracts keep the Latch names: latch is the mechanism, Nandout is the product.</span>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
