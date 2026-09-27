import { NextResponse } from 'next/server';
import { fetchLaunches, rank, toRow } from '@/lib/ignix';
import { outsideRows, readRegistry } from '@/lib/registry';

export const revalidate = 60;

/** Every Ignix launch as compact rows, ranked (graduated, agent-linked, most holders first). Cached 60 s. */
export async function GET() {
  try {
    const [ls, reg] = await Promise.all([fetchLaunches(), readRegistry()]);
    const rows = [...rank(ls).map(toRow), ...outsideRows(reg)];
    return NextResponse.json({ rows }, { headers: { 'cache-control': 'public, max-age=60, stale-while-revalidate=120' } });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
