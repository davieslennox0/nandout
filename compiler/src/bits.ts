// Latch input bit schema. Must stay in sync with contracts/src/LatchBits.sol (checked by the fixture test).

export const BITS = {
  AGENT_LINKED: 0,
  REV_GT_0: 1, // agent has any recorded revenue
  REV_GE_10: 2, // agent revenue >= $10
  LP_LOCKED: 3,
  TOP10_LT_40: 4,
  TOP10_LT_25: 5,
  DEV_NO_SELL_7D: 6,
  LATCH_LOCKED: 7,
  AGE_GE_7D: 8,
  AGE_GE_30D: 9,
  HOLDERS_GE_100: 10,
  HOLDERS_GE_300: 11,
  LP_PULLED: 12, // graduated pair whose recognised-locker LP share fell below threshold (reset signal)
} as const;

export type BitName = keyof typeof BITS;

export const N_IN = 16;
export const N_OUT = 1;

/** Bits computed on-chain by LatchGate; never attested. */
export const ONCHAIN_BITS: readonly BitName[] = ['LATCH_LOCKED', 'AGE_GE_7D', 'AGE_GE_30D'];

export const ATTESTED_MASK = (Object.keys(BITS) as BitName[])
  .filter((b) => !ONCHAIN_BITS.includes(b))
  .reduce((m, b) => m | (1 << BITS[b]), 0);

export const ONCHAIN_MASK = ONCHAIN_BITS.reduce((m, b) => m | (1 << BITS[b]), 0);

export const RESERVED_MASK = 0xe000;

/**
 * Bit schema: input name -> input index (0..15). Latch uses BITS; other consumers of the same processor and evaluator
 * (e.g. the fee hook in hook/) pass their own. Unused indices must read as 0 in the consumer's fact word.
 */
export type Schema = Readonly<Record<string, number>>;

export function isBitName(s: string): s is BitName {
  return Object.prototype.hasOwnProperty.call(BITS, s);
}
