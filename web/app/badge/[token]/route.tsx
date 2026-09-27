// Embeddable lock badge: /badge/{token}.svg (or .png). Re-reads X Layer on every miss; cached for 60s.
import { ImageResponse } from 'next/og';
import { deployed } from '@/lib/config';
import { fmtDuration } from '@/lib/explain';
import { summarize } from '@/lib/lockstatus';
import { parseToken, readToken } from '@/lib/lockview';

export const dynamic = 'force-dynamic';

const CACHE = 'public, max-age=60, s-maxage=60, stale-while-revalidate=120';
const H = 28;
const CW = 7.2; // monospace advance at 12px
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

interface Badge { label: string; value: string; detail: string; color: string; ink: string }

async function badgeFor(raw: string): Promise<Badge> {
  const label = 'nandout';
  const unknown = { label, value: 'UNKNOWN TOKEN', detail: '', color: '#3a3d44', ink: '#f4f6f9' };
  const token = parseToken(raw);
  if (!token || !deployed) return unknown;
  let v;
  try { v = await readToken(token); } catch { return { ...unknown, value: 'UNAVAILABLE', detail: 'chain read failed' }; }
  const s = summarize(v);
  if (s.state === 'UNKNOWN TOKEN') return unknown;
  if (s.state === 'LOCKED') {
    const next = s.nextUnlock === 0 ? 'unlock ready' : s.nextUnlock !== null ? `next unlock ${fmtDuration(s.nextUnlock)}` : 'unlock on conditions';
    return { label, value: `LOCKED ${s.pct}%`, detail: next, color: '#3fb27f', ink: '#0a0a0b' };
  }
  return { label, value: 'NOT LOCKED', detail: s.pct > 0 ? `${s.pct}% < ${s.thresholdPct}%` : '', color: '#c99a4e', ink: '#0a0a0b' };
}

function svg(b: Badge): string {
  const right = b.detail ? `${b.value} · ${b.detail}` : b.value;
  const lw = Math.round(b.label.length * CW + 34);
  const rw = Math.round(right.length * CW + 20);
  const w = lw + rw;
  const title = `Nandout lock status: ${right}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${H + 11}" viewBox="0 0 ${w} ${H + 11}" role="img" aria-label="${esc(title)}">
<title>${esc(title)}</title>
<clipPath id="r"><rect width="${w}" height="${H}" rx="6"/></clipPath>
<g clip-path="url(#r)"><rect width="${lw}" height="${H}" fill="#0a0a0b"/><rect x="${lw}" width="${rw}" height="${H}" fill="${b.color}"/></g>
<g transform="translate(8 6) scale(0.5)"><rect width="32" height="32" rx="9" fill="#f4f6f9"/><path d="M8 9h7a7 7 0 0 1 0 14H8z" fill="none" stroke="#0a0a0b" stroke-width="2.4"/><circle cx="24.2" cy="16" r="2.2" fill="none" stroke="#0a0a0b" stroke-width="2.2"/></g>
<g font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="12" font-weight="600">
<text x="28" y="18.5" fill="#f4f6f9">${esc(b.label)}</text>
<text x="${lw + 10}" y="18.5" fill="${b.ink}">${esc(right)}</text>
</g>
<text x="${w}" y="${H + 9}" text-anchor="end" font-family="ui-monospace,Menlo,monospace" font-size="8" fill="#8a8f98">nandout.xyz</text>
</svg>`;
}

function png(b: Badge) {
  const right = b.detail ? `${b.value} · ${b.detail}` : b.value;
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'flex-start', padding: '0 24px', background: '#0a0a0b' }}>
        <div style={{ display: 'flex', borderRadius: 14, overflow: 'hidden', fontSize: 30, fontWeight: 700 }}>
          <div style={{ display: 'flex', padding: '14px 20px', background: '#1b1d22', color: '#f4f6f9' }}>nandout</div>
          <div style={{ display: 'flex', padding: '14px 20px', background: b.color, color: b.ink }}>{right}</div>
        </div>
        <div style={{ display: 'flex', marginTop: 8, fontSize: 16, color: '#8a8f98' }}>nandout.xyz</div>
      </div>
    ),
    { width: 600, height: 120, headers: { 'Cache-Control': CACHE } },
  );
}

export async function GET(_req: Request, { params }: { params: { token: string } }) {
  const m = /^(.*?)(?:\.(svg|png))?$/i.exec(params.token)!;
  const b = await badgeFor(m[1]);
  if ((m[2] ?? 'svg').toLowerCase() === 'png') return png(b);
  return new Response(svg(b), { headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': CACHE, 'X-Content-Type-Options': 'nosniff' } });
}
