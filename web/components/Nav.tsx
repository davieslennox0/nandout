'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Wallet } from './Wallet';

const LINKS = [
  ['/', 'Launches'],
  ['/build', 'Build'],
  ['/lock', 'Lock'],
  ['/circuits', 'Circuits'],
  ['/treasury', 'Treasury'],
  ['/docs', 'Docs'],
] as const;

export function Nav() {
  const path = usePathname();
  return (
    <header className="nav">
      <Link href="/" className="brand">
        <span className="brand-mark" aria-hidden>
          ⊼
        </span>
        Nandout
      </Link>
      <nav>
        {LINKS.map(([href, label]) => (
          <Link key={href} href={href} className={path === href ? 'active' : ''}>
            {label}
          </Link>
        ))}
      </nav>
      <Wallet />
    </header>
  );
}
