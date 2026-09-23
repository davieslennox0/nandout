// Starter circuits taped out on the Latch processor (LATCH_PROMPT.md §8).

export const STARTERS: Record<string, unknown> = {
  // Filters
  BASIC_SAFETY: { all: ['LP_LOCKED', 'TOP10_LT_40', 'DEV_NO_SELL_7D'] },
  REVENUE_AGENTS: { all: ['AGENT_LINKED', 'REV_GT_0', 'LP_LOCKED'] },
  STRICT: {
    all: ['AGENT_LINKED', 'REV_GT_0', 'LP_LOCKED', 'TOP10_LT_25', 'DEV_NO_SELL_7D', { any: ['LATCH_LOCKED', 'AGE_GE_30D'] }],
  },
  // Unlock circuits
  UNLOCK_T1: { all: ['AGE_GE_7D', 'LP_LOCKED', 'HOLDERS_GE_100'] },
  UNLOCK_T2: { all: ['AGE_GE_30D', 'REV_GE_10', 'HOLDERS_GE_300', 'LP_LOCKED'] },
  // Stateful filter (§17): trust is earned on the curve and kept until the dev sells or LP is pulled.
  // CURVE_SAFETY = TOP10_LT_40 AND DEV_NO_SELL_7D AND HOLDERS_GE_100; DEV_SELL = NOT DEV_NO_SELL_7D.
  STICKY_SAFETY: {
    latch: {
      set: { all: ['TOP10_LT_40', 'DEV_NO_SELL_7D', 'HOLDERS_GE_100'] },
      reset: { any: [{ not: 'DEV_NO_SELL_7D' }, 'LP_PULLED'] },
    },
  },
};
