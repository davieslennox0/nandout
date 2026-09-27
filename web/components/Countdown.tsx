'use client';

import { useEffect, useState } from 'react';
import { fmtDuration } from '@/lib/explain';

/** Ticks down to a unix time. Server render shows the value at the snapshot block; the client keeps it current. */
export function Countdown({ to }: { to: number }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Math.floor(Date.now() / 1000));
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(t);
  }, []);
  const left = now === null ? null : to - now;
  return (
    <span title={new Date(to * 1000).toISOString()}>
      {left === null ? new Date(to * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : fmtDuration(left)}
    </span>
  );
}
