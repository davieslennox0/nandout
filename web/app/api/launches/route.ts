import { NextResponse } from 'next/server';
import { fetchLaunches } from '@/lib/ignix';

export const revalidate = 60;

/** Token addresses of every Ignix launch (server-side proxy of the public index, cached 60 s). */
export async function GET() {
  try {
    const launches = await fetchLaunches();
    return NextResponse.json({ tokens: launches.map((l) => l.tokenAddress), symbols: Object.fromEntries(launches.map((l) => [l.tokenAddress, l.symbol])) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
