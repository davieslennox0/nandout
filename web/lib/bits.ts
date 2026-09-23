import { BITS, ONCHAIN_BITS, type BitName } from '@latch/compiler';

export const BIT_LABELS: Record<BitName, string> = {
  AGENT_LINKED: 'Linked to an OKX.AI agent',
  REV_GT_0: 'Agent has revenue',
  REV_GE_10: 'Agent revenue ≥ $10',
  LP_LOCKED: 'LP locked',
  TOP10_LT_40: 'Top-10 < 40% of circulating',
  TOP10_LT_25: 'Top-10 < 25% of circulating',
  DEV_NO_SELL_7D: 'No dev outflow in 7 days',
  LATCH_LOCKED: 'Creator allocation in LatchLock',
  AGE_GE_7D: 'Older than 7 days',
  AGE_GE_30D: 'Older than 30 days',
  HOLDERS_GE_100: '≥ 100 holders',
  HOLDERS_GE_300: '≥ 300 holders',
  LP_PULLED: 'LP pulled (permanent)',
};

export const BIT_NAMES = Object.keys(BITS) as BitName[];

export const isOnchain = (b: BitName) => (ONCHAIN_BITS as readonly string[]).includes(b);

export const decode = (word: number) => BIT_NAMES.filter((b) => (word >> BITS[b]) & 1);
