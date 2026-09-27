'use client';

import { useState } from 'react';

const SITE = 'https://nandout.xyz';

/** Copyable badge + link snippets for a token's lock page. */
export function ShareSnippets({ token, symbol, fresh }: { token: string; symbol: string; fresh?: boolean }) {
  const page = `${SITE}/lock/${token}`;
  const svg = `${SITE}/badge/${token}.svg`;
  const items = [
    ['Markdown', `[![Nandout lock status for $${symbol}](${svg})](${page})`],
    ['HTML', `<a href="${page}"><img src="${svg}" alt="Nandout lock status for $${symbol}" height="28"></a>`],
    ['Badge (SVG)', svg],
    ['Badge (PNG)', `${SITE}/badge/${token}.png`],
    ['Page', page],
  ] as const;
  const [copied, setCopied] = useState<string | null>(null);
  return (
    <>
      <div className="section-label">{fresh ? 'Locked. Share it' : 'Share'}<span>the badge re-reads the chain every minute</span></div>
      <div className="card">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`/badge/${token}.svg`} alt={`Nandout lock status for $${symbol}`} height={28} />
        <div className="snippets">
          {items.map(([label, text]) => (
            <div key={label} className="snippet">
              <span className="muted small">{label}</span>
              <code>{text}</code>
              <button
                className="ghost small"
                onClick={() => navigator.clipboard?.writeText(text).then(() => { setCopied(label); setTimeout(() => setCopied(null), 1500); })}
              >
                {copied === label ? 'Copied' : 'Copy'}
              </button>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
