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

## Gas (real receipts, local fork at X Layer block 71,784,310)

`hook/script/gas-report.sh` writes [`hook/gas-report.json`](../hook/gas-report.json). The table shows steady-state
swaps (average of swaps 2–4 in a pool).

| Pool | Swap gas | vs plain |
|---|---|---|
| No hook, static 0.30% | 124,370 | — |
| **FeeCircuitHook: table lookup** | **136,544** | **+12,174 (+9.8%)** |
| Same hook, both circuits evaluated live every swap | 190,300 | +65,930 (+53%) |

- **Facts included:** the +9.8% covers all the fact measurement: slot0, liquidity, and both window slots.
- **First swap in a pool:** +53k once, when the two window slots are first written.
- **Epoch rollover:** the first swap of each epoch rewrites the window slot. This was not measured separately; it is
  bounded by one warm SSTORE (~3–5k).
- **Hook deployment:** 3,421,444 gas, including the 64 evaluations and two netlist snapshots.

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
inside the +12,174 above: one cold SLOAD per swap, and a write only when liquidity sets a new low.

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

## Why NexusHook cannot host Ignix tokens (checked 2026-09-28)

We planned the first live pool on IGNIXFROG, a graduated Ignix launch paired with wQQQx. It is impossible, for a reason
unrelated to the hook:

- **Ignix taxes the V4 PoolManager.** IGNIXFROG takes **3% on transfers to and from its v2 pair and to and from the V4
  PoolManager** (`0x360E…FB32`). Transfers to ordinary addresses, and to LatchLock, are untaxed.
- **V4 cannot absorb a tax.** It settles exact amounts, so a pool holding a token that loses 3% in transit can never
  settle. A plain hookless pool fails with `CurrencyNotSettled()` on the first add-liquidity.
- **Pinned in CI:** `hook/test/IgnixFrogPool.fork.t.sol` asserts both the tax figures and the failure.

Ignix evidently treats the PoolManager as a taxed venue, which also stops anyone from routing around the creator's tax
through a V4 pool. A NexusHook pool needs untaxed tokens, such as wQQQx, USDT0 or xETH.

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

Here that took per-swap overhead from +66k (live) to +12k (table), with facts measured the same way in both.

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
| FeeCircuitHook deploy (hook-address mining is local and free) | 3.42M | **0.068** |
| One pool: initialize + add liquidity | ~0.31M | **0.006** (plus the liquidity itself, which is capital) |
| **Lean total** (existing tokens and router) | | **≈ 0.10 OKB** (≈ 0.09 net of transistor proceeds) |
| + two demo ERC-20s, a swap router, ~10 demo swaps | ~4.8M | + ≈ 0.10 → **≈ 0.20 OKB** |

No mainnet transaction has been sent for NexusHook.
