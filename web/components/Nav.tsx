'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Wallet } from './Wallet';

const LINKS = [
  ['/', 'Launches'],
  ['/build', 'Build'],
  ['/lock', 'Lock'],
  ['/creators', 'Creators'],
  ['/hook', 'Hook'],
  ['/circuits', 'Circuits'],
  ['/treasury', 'Treasury'],
  ['/docs', 'Docs'],
] as const;

/** NAND gate glyph: the only primitive Nandout circuits are made of. */
export function Mark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="9" fill="var(--accent)" />
      <path d="M8 9h7a7 7 0 0 1 0 14H8z" fill="none" stroke="#0a0a0b" strokeWidth="2.4" strokeLinejoin="round" />
      <circle cx="24.2" cy="16" r="2.2" fill="none" stroke="#0a0a0b" strokeWidth="2.2" />
    </svg>
  );
}

export function Nav() {
  const path = usePathname();
  return (
    <header className="nav">
      <Link href="/" className="brand">
        <Mark />
        Nandout
        <span className="tagline">launch gate for Ignix</span>
      </Link>
      <nav className="links" aria-label="Sections">
        {LINKS.map(([href, label]) => (
          <Link key={href} href={href} className={path === href || (href !== '/' && path.startsWith(href + '/')) ? 'on' : ''}>
            {label}
          </Link>
        ))}
      </nav>
      <div className="header-right">
        <Wallet />
      </div>
    </header>
  );
}
