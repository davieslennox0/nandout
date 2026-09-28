# NexusHook: circuit-governed LP fees (FeeCircuitHook)

NexusHook is the second consumer of Nandout's decision layer. The first is the Gate. It sets the LP fee of a Uniswap v4
pool on X Layer from a **taped-out TapeOut circuit**, not an admin parameter.

**The claim, and only this claim:** the fee *policy* is an immutable, publicly readable, forkable circuit over immutable
thresholds. Nobody, including us, can quietly change the rules on LPs or traders. It is not "AI-driven dynamic fees",
and the circuit does not compute fees: it cannot do arithmetic.

**Status:** fork-proven, **not deployed**. Everything below comes from tests against a local fork of X Layer mainnet, using
the real PoolManager, the real Nandout processor and the real LatchEvaluator. Phase 0 feasibility is in
[`HOOK-RECON.md`](HOOK-RECON.md).

## How it works

```
 pool state ─► Solidity: measure + threshold ─► 5 fact bits ─► table[facts] ─► tier (2 bits) ─► LP fee (fixed per tier)
                                                                  ▲
                    built once, in the constructor, by LatchEvaluator
                    running the two frozen taped-out netlists over all 32 fact words
```

| Bit | Fact | Measured how |
|---|---|---|
| 0 | `VOL_HIGH` | windowed volatility ≥ `volHigh` |
| 1 | `VOL_ELEVATED` | windowed volatility ≥ `volElevated` |
| 2 | `DEPTH_THIN` | windowed depth < `depthThin` |
| 3 | `DEPTH_CRITICAL` | windowed depth < `depthCritical` |
| 4 | `DEPTH_DRAIN` | current liquidity < half the previous epoch's floor (LPs leaving) |

| Circuit (6 gates each) | Rule | Tier bit |
|---|---|---|
| `VOL_GUARD` | `VOL_HIGH OR (VOL_ELEVATED AND (DEPTH_THIN OR DEPTH_DRAIN))` | high |
| `DEPTH_GUARD` | `DEPTH_THIN OR DEPTH_CRITICAL OR DEPTH_DRAIN` | low |

The tier is `(VOL_GUARD << 1) | DEPTH_GUARD`, which picks one of four fees fixed at deploy. The tests use
0.05% / 0.30% / 0.60% / 1.00%.

- **Compiling:** the repo's compiler builds both circuits from `hook/circuits/compile.ts` (fee bits passed as the bit
  schema). It verifies them exhaustively over all 2^16 inputs and fails hard on any mismatch. CI regenerates the fixture
  and fails if it drifts.
- **Tape-out:** both circuits are taped out on **Nandout's existing processor** `0x8A60…a58E`. There is no second
  processor.
- **Evaluation:** they are evaluated by **Nandout's deployed LatchEvaluator** `0x8cA3…2D03`, reused directly rather than
  duplicated. Each guard is an ordinary 16-in/1-out circuit, the shape LatchEvaluator already handles; fact bits 5–15
  are always 0.
- **Registration:** the constructor does exactly what `LatchGate.registerFilter` does. It checks the CPU is a registered
  TapeOut CPU and the circuit is 16-in/1-out and stateless. It pulls the netlist, checks its hash against the verified
  compile, runs `analyze` (so any REF reverts), and freezes it with SSTORE2. It then evaluates both circuits for all 32
  fact words and stores the 64-bit table as an immutable.
- **No admin:** no owner, no setters, no proxy, no selfdestruct. Pools must use `fee = DYNAMIC_FEE_FLAG`, and
  `beforeSwap` returns `fee | OVERRIDE_FEE_FLAG`.
- **Why the hook never calls TapeOut after construction:** TapeOut's factory is upgradeable (`isSealed() == false`, owner
  `0x571d…aF15`). Same posture as LatchLock.

## Tests (`hook/test/`, local fork of X Layer mainnet)

| Test | What it proves |
|---|---|
| `test_tableEqualsLiveTapeOutEvalForEveryFactWord` | For all 32 fact words: hook table = TapeOut's live `eval` = LatchEvaluator on the frozen netlist = the DSL. The stored netlists hash to the taped-out bytes, so anyone can recompute the table. |
| `test_poolChargesLiveEvalFeeForEveryFactWord` | 32 real swaps, one per fact word. The fee the PoolManager applied (from its `Swap` event) is always the fee of the live-evaluated tier. |
| `test_maliciousTapeOutUpgradeCannotChangeFee` | Replaces the processor's code with a hostile one (every eval passes, netlists garbage) and confirms the live path is compromised. All 32 fees are unchanged. |
| `test_constructorRejectsWrongNetlistAndNonTapeOutCpu` | `NetlistMismatch` for bytes other than the verified compile; `NotTapeOutCircuit` for a CPU TapeOut doesn't know. |
| `test_depthWindowBlocksJitLiquidity` | See attack 2. |
| `test_volatilityManipulationCost` | See attack 1. |
| `Recon.fork.t.sol` | X Layer's PoolManager is byte-identical to Uniswap's canonical deployment apart from its self-address immutable. |

## Gas (real receipts, local fork)

`hook/script/gas-report.sh` writes [`hook/gas-report.json`](../hook/gas-report.json). All four pools come from the same
run: 6 alternating swaps each, averaging swaps 3–6, so the window slots are written and both route sinks already hold
a balance.

| Pool | Swap gas | vs plain |
|---|---|---|
| No hook, static 0.30% | 119,612 | — |
| **FeeCircuitHook: tier via table lookup** | **132,896** | **+13,284 (+11.1%)** |
| Same hook, both tier circuits evaluated live every swap | 185,554 | +65,942 (+55.1%) |
| **FeeRouteHook: tier + route (table lookups)** | **148,905** | **+29,293 (+24.5%)** |

- **Methodology:** an earlier run of the tier hook, averaging swaps 2–4 of 4, measured +12,174 (+9.8%). The difference is
  the method, not the hook.
- **What routing costs:** the route lookup is two table reads and a transient-storage handoff. Most of routing's extra
  ~16k is the fee actually moving: one ERC-20 transfer (`take`) to the destination, plus the `afterSwap` callback and a
  `Routed` event.
- **A possible optimisation (not built):** accrue route fees as PoolManager ERC-6909 claims and pay them out in batches.
  That would trade the per-swap transfer for a claims write plus a separate payout.
- **Deploy gas:** tier-only 3,421,444; tier + route 5,240,135 (128 evaluations and four netlist snapshots).

## Attack 1: volatility manipulation (raising everyone's fee)

**Measure:** once per 60-block epoch (~60 s), the hook samples the tick **before the epoch's first swap executes**.
Volatility is an EWMA of per-epoch displacement, `vol = (3·vol + 100·|Δtick|) / 4`. One epoch displaced by 800 ticks
(~8.3%) reaches `VOL_HIGH`.

**Numbers** (`test_volatilityManipulationCost`; pool with L = 1e23 over ±6000 ticks, price 1:1, deep, calm, 0.05% tier):

| Scenario | Result |
|---|---|
| Push the price 800 ticks and back **within one epoch** (4,083 token1 in / 4,081 token1 back) | **No trace.** The next epoch's sample sees the original tick and the fee stays 0.05%. Phase 0's per-swap EWMA would have registered this for fees alone. |
| Hold the 800-tick displacement **across the boundary** (last block of epoch k, then the attacker unwinds in the first block of k+1) | `VOL_HIGH` is set and everyone pays **0.60% for 3 epochs (~3 min)**. The attacker's unwind is itself the sampled swap, so it is charged the raised tier. **Attacker cost: 2.04 token1 + 23.67 token0 ≈ 25.7 tokens ≈ 0.63% of the 4,083 notional.** |
| Same, but an arbitrageur takes the first swap of the new epoch | The attacker is left holding 3,920.9 token0 bought for 4,082.9 token1: **≈ 162 tokens (≈ 4.0% of notional)** lost to the arbitrageur. X Layer's sequencer orders transactions first-come-first-served, so the attacker cannot guarantee being first. |

**Is it economic?** Raising the fee only pays LPs. An attacker who is an LP with pool share *s* earns
*s* × 0.55% × (other traders' volume during those ~3 minutes).
- **Outside attacker (s ≈ 0):** never profitable.
- **LP attacker:** with the self-unwind cost of 25.7, it breaks even only above ~4,700/*s* tokens of organic volume in
  3 minutes, more than the attack's own notional. It's ~29,500/*s* if an arbitrageur unwinds.
- **Dominant LP:** the attack is cheapest for the pool's dominant LP, because the fees the attacker pays mostly flow back
  to them. Windowing still forces them to carry the one-block arbitrage risk (~4% of notional here).
- **Harm is bounded:** traders pay the published 0.60% tier for ~3 minutes, and can route elsewhere.

Windowing makes the attack costly and visible; it does not make it impossible for a large LP.

## Attack 2: depth gaming (JIT liquidity for a lower tier)

**Measure:** depth = min(current in-range liquidity, the lowest liquidity observed during the current epoch, the lowest
observed during the last epoch that had swaps). This takes a second storage slot (`curMin`), which we took. Its cost is
inside the tier hook's overhead above: one cold SLOAD per swap, and a write only when liquidity sets a new low.

**Numbers** (`test_depthWindowBlocksJitLiquidity`; thin pool, L = 5e21 < `depthThin` 1e22, so the 0.30% tier applies):

| Step | Fee charged |
|---|---|
| Attacker adds **+1e24 liquidity (200×)** in the same block as its own swap | **0.30%** (a naive current-liquidity check would have given 0.05%) |
| Keeps it until the next epoch | 0.30% (the previous epoch's floor was thin) |
| Keeps it through a **whole epoch** in which every observation sees it | 0.05% |

- **How long it had to stay:** 94 blocks (~94 s) in the test. The minimum is always one full epoch (60 blocks) plus the
  rest of the current one.
- **What that costs the attacker:** the liquidity is exposed to every swap and price move in that time, which makes it
  ordinary LP capital, not a flash trick.
- **What it buys:** 0.25% off one swap.

## FeeRoute: the circuit chooses where the fee goes

`FeeRouteHook` extends `FeeCircuitHook`; one hook address carries both permission sets (beforeSwap + afterSwap +
afterSwapReturnsDelta, so the address ends in `0x…00C4`).
- **What it adds:** a fixed route fee (`routeBps`, 1% in the tests) on the unspecified side of every swap. Two more
  taped-out circuits choose its **destination** from four addresses fixed at deploy.
- **Why it matters:** the fee rate is the smaller claim. Fee destination is where rug risk lives: "nobody can redirect
  your fees" is the stronger promise.

| Circuit | Rule | Gates |
|---|---|---|
| `ROUTE_SPLIT` | `NOT IS_BUY` | 1 |
| `ROUTE_GUARD` | `VOL_HIGH OR DEPTH_THIN` | 3 |

- **Routes:** `route = (ROUTE_GUARD << 1) | ROUTE_SPLIT`.
  - A calm **buy** pays route 0 (reserve).
  - A calm **sell** pays route 1 (holder sink).
  - When volatility is high or depth is thin, routes 2/3 **donate the fee to in-range LPs**, compensating them exactly
    when they carry the most risk.
- **Facts:** `IS_BUY` is the swap direction relative to the configured token, straight from the params. `VOL_HIGH` and
  `DEPTH_THIN` are the same windowed facts the tier circuits use. Bits 3–4 are spare and always 0. There are no
  attested facts and no arithmetic in the circuit.
- **Table:** as with the tier, all 32 answers are computed once in the constructor by LatchEvaluator on frozen netlists
  and stored as an immutable 64-bit table.

**Accounting (v4 settles exactly, and this does too):**
- `beforeSwap` computes the route from pre-swap facts and hands it to `afterSwap` through transient storage.
- `afterSwap` takes `routeBps` of the unspecified amount, the same pattern as v4-core's `FeeTakingHook`, and returns it
  as the hook's delta, so the swapper pays it.
- In the same callback, the hook resolves its own delta: `take(currency, destination, fee)`, or `donate(key, …)` for the
  LP routes. Net hook delta: zero.

**Tests** (`hook/test/FeeRoute.fork.t.sol`):

| Test | What it proves |
|---|---|
| `test_routeTableEqualsLiveTapeOutEvalForEveryFactWord` | Route table = TapeOut live `eval` = LatchEvaluator on the frozen netlists = DSL, for all 32 words. |
| `test_buysToReserveSellsToHoldersReconcileExactly` | Exact-in buy: the reserve receives exactly 1% of the pool's output, the swapper the rest, and the PoolManager released exactly output + fee. Same for an exact-in sell to the holder sink. Exact-out buy: the output is delivered in full and 1% of the input is charged on top. |
| `test_guardRoutesFeeToLpsAndReconciles` | On a thin pool, a sell routes to LPs. The sinks receive nothing, only the swapper's output leaves the PoolManager, and `feeGrowthGlobal0` rises by exactly `fee × 2^128 / liquidity`. |
| **`test_maliciousTapeOutUpgradeCannotRedirectFees`** | Drives all 8 reachable route words through real swaps, then replaces the processor with a hostile CPU. It confirms the live path now misclassifies a calm buy, then shows every route and destination unchanged. |
| `test_rejectsRouteFeeOutOfRange` | `routeBps` above 1,000 (10%) is refused at deploy. |

**Where the pattern comes from:** direction-asymmetric fee routing is visible in the wild, for example a Solana token that
routes buys to a reserve and sells to holder payouts. Our contribution is making the routing policy an immutable,
publicly readable circuit rather than an admin setting.

## Ignix tokens and V4: the tax is set per launch (fork survey, 2026-09-28)

Ignix launches can tax transfers into the V4 PoolManager, and V4 settles exact amounts, so a taxed token cannot sit in any
V4 pool. The rate is **configured per launch**. We surveyed all 48 graduated Ignix launches other than IGNIXFROG on a
fork.
- **Method:** each token moves holder → fresh address A → (a fresh address B, and the PoolManager). Rates are measured
  in basis points lost.
- **Data:** [`data/ignix-v4-tax-survey.csv`](data/ignix-v4-tax-survey.csv).

| Tax into the V4 PoolManager | Launches |
|---|---|
| **0%: poolable** | **13** |
| ~1% | 20 |
| ~2% | 7 |
| ~3% | 5 (plus IGNIXFROG, surveyed earlier) |
| ~10% | 1 |
| Transfer reverts | 2 (V4-template JACKET and EEEE) |

- **Ordinary transfers are free everywhere:** no launch taxed holder → A or A → B.
- **The poolable 13:** TAPEOUTX (2 launches), LING, HASH (2), OKCOIN, DUO, ICEBULL, PIKA, RUOK, BODHI, XCAT and 牛回.
  **All 13 pool and reconcile exactly in a FeeRouteHook pool on the fork**: buy and sell, the route fee to the
  destination, and every amount in and out of the PoolManager to the wei (`hook/test/IgnixPoolable.fork.t.sol`).
- **Taxed tokens fail:** IGNIXFROG (3%) fails on the first liquidity add, even without a hook
  (`hook/test/IgnixFrogPool.fork.t.sol`, in CI).
- **Some already have V4 pools**, created by other people: Ignix's own hooked pools for OKCOIN and ICEBULL
  (hook `0xeb7e…6080`, 0.30%); a dynamic-fee hooked pool for TAPEOUTX; and several unhooked pools, some with absurd
  fees (up to 99.9999%) that look like junk or trap pools.
- **Running the survey:** it is opt-in (`IGNIX_SURVEY=true`), because it reads live holder balances and takes minutes.

## Deferred: MILESTONE (agent revenue → lower tier)

A `MILESTONE` fact ("the pool token's agent has revenue ≥ threshold") needs an attestor. Candidates are nandout's
LatchFeed `REV_GE_10` bit (Ignix tokens only) or a separate attestor. Either way, the fee policy would inherit:

- **an availability dependency:** a stale feed must not keep granting a discount;
- **a trust dependency:** LatchFeed is `Ownable2Step`, and its owner controls the attestor set.

Designed fallback, if it is ever added:
- read `getBits(token)` and `isFresh()` once per epoch, not per swap (~2.6k gas at the rollover);
- set `MILESTONE` only if the feed is fresh **and** the bit is set, so a stale or dead feed fails closed to the
  higher-fee tiers;
- snapshot the value into the window slot, so a feed outage cannot flip the fee mid-epoch.

Even so, "nobody can change the rules" would weaken to "the rules are fixed, but one input is attested". That's why it's
out of v1.

## General result: precompute the circuit, look it up

**Any hot path can precompute a TapeOut circuit's complete output and look it up.** For a circuit with *k* input bits
and *m* output bits:
- evaluate it 2^k times once, on-chain, with an immutable evaluator on the frozen netlist;
- store the 2^k·m-bit table (one storage word up to 2^k·m = 256);
- each call is then a shift and a mask, not a netlist evaluation.

Here that took per-swap overhead from +66k (live) to +13k (table), with facts measured the same way in both.

**Trust is unchanged:**
- the table is derived on-chain from the taped-out bytes;
- the netlist stays stored and publicly re-evaluable;
- a TapeOut upgrade cannot touch either.

**The limit is k.** The one-time cost is 2^k evaluations (64 here, part of the 3.42M-gas deploy), so small fact
vocabularies such as 5 bits are cheap. At 16 inputs it's 65,536 evaluations, which isn't practical. This is what makes
immutable circuit logic viable where per-call evaluation is not.

## Mainnet cost, if funded before Oct 6 (at 0.02 gwei)

| Item | Gas | OKB |
|---|---|---|
| Tape out VOL_GUARD + DEPTH_GUARD on the Nandout processor | 2 × (86k mint + ~227k tape-out) ≈ 626k | 0.0125 gas + 0.0159 fees = **0.028** |
| └ of which transistors, 12 × 0.001 OKB | | 0.012, paid to the processor's creator (Nandout's own deployer), so it comes back |
| └ TapeOut protocol fee 2 × 0.00066 + tape-out fee 2 × 0.0013 | | 0.0039 |
| FeeCircuitHook deploy (hook-address mining is local and free) | 3.42M | **0.068** (FeeRouteHook: 5.24M = 0.105, plus two more tape-outs ≈ 0.02) |
| One pool: initialize + add liquidity | ~0.31M | **0.006** (plus the liquidity itself, which is capital) |
| **Lean total** (existing tokens and router) | | **≈ 0.10 OKB** (≈ 0.09 net of transistor proceeds) |
| + two demo ERC-20s, a swap router, ~10 demo swaps | ~4.8M | + ≈ 0.10 → **≈ 0.20 OKB** |

No mainnet transaction has been sent for NexusHook.
