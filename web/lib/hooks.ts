'use client';

import { useReadContract, useReadContracts } from 'wagmi';
import { gateAbi } from './abi';
import { DEPLOYMENT } from './config';

export interface FilterInfo {
  id: number;
  name: string;
  cpu: `0x${string}`;
  circuitId: bigint;
  gateCount: number;
  nState: number;
  netlistHash: `0x${string}`;
  registrant: `0x${string}`;
}

/** Every filter registered on LatchGate (empty when not deployed). */
export function useFilters(): { filters: FilterInfo[]; isLoading: boolean; error: Error | null } {
  const count = useReadContract({
    address: DEPLOYMENT.gate,
    abi: gateAbi,
    functionName: 'filterCount',
    query: { enabled: Boolean(DEPLOYMENT.gate) },
  });
  const n = Number(count.data ?? 0n);
  const infos = useReadContracts({
    contracts: Array.from({ length: n }, (_, i) => ({
      address: DEPLOYMENT.gate!,
      abi: gateAbi,
      functionName: 'getFilter' as const,
      args: [BigInt(i + 1)] as const,
    })),
    query: { enabled: n > 0 },
  });
  const filters: FilterInfo[] = (infos.data ?? []).flatMap((r, i) =>
    r.status === 'success'
      ? [{ id: i + 1, name: r.result.name, cpu: r.result.cpu, circuitId: r.result.circuitId, gateCount: r.result.gateCount, nState: r.result.nState, netlistHash: r.result.netlistHash, registrant: r.result.registrant }]
      : [],
  );
  return { filters, isLoading: count.isLoading || infos.isLoading, error: (count.error ?? infos.error) as Error | null };
}
