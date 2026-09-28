# NexusHook: Phase 0 recon

> **Superseded in part by Phase 1** ([`HOOK.md`](HOOK.md)): live per-swap evaluation was rejected in favour of a
> table precomputed at registration, MILESTONE was deferred, the Phase 0 `FeeEvaluator`/`BenchHook` benchmark code was
> replaced by the real `FeeCircuitHook` (which reuses Nandout's deployed LatchEvaluator), and the gas numbers below were
> re-measured on the real hook. This file is kept as the feasibility record.

Date: 2026-09-27. X Layer mainnet (chain 196). **No mainnet transactions were sent.** All measurements come from a
local anvil fork of X Layer mainnet (fork block 71,781,136) using the real PoolManager bytecode, and a throwaway key
that exists only on that fork. Reproduce with `script/Bench.s.sol` (see the bottom of this file).

## TL;DR

| Question | Answer |
|---|---|
| Uniswap V4 on X Layer mainnet? | **Yes.** PoolManager `0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32`. |
| Genuine v4-core? | **Yes.** Runtime bytecode is byte-identical to Ethereum's canonical PoolManager `0x000000000004444c5dc75cB358380D2e3dE08A90` except the 20-byte `NoDelegateCall` self-address immutable. |
| Dynamic LP fee from `beforeSwap`? | **Yes, verified on the fork.** Pool initialised with fee `0x800000` (DYNAMIC_FEE_FLAG); the hook returns `fee \| 0x400000` (OVERRIDE_FEE_FLAG); the PoolManager's `Swap` event recorded the circuit-selected fee (500 / 3000 / 10000 / 30000 pips). |
| Hook address mining | Only `BEFORE_SWAP_FLAG` (bit 7): the low 14 address bits must equal `0x0080`. 1 in 16,384 salts. Observed 2,558 – 22,615 tries per hook (seconds, off-chain, **zero on-chain cost**). The canonical CREATE2 deployer `0x4e59b448…956C` exists on X Layer. |
| Pool creation cost | `initialize` ≈ 51.7k gas (≈ 0.0010 OKB); adding liquidity ≈ 259k gas (≈ 0.0052 OKB). |
| Per-swap gas: circuit evaluated live every swap | **+43k (8 gates) / +61k (16) / +98k (32) gas: +35% to +79% per swap.** ~2.3k gas per gate. Three separate circuits per swap would roughly double the swap. **Not acceptable.** |
| Per-swap gas: circuit's truth table frozen at registration | **+12.7k gas (+10%)**; +18.7k (+15%) including the per-swap volatility observation. **Acceptable.** |
| Circuit does arithmetic? | **No.** Solidity computes thresholds → bits; the circuit maps bits → a 2-bit tier. Nothing in this design needs arithmetic inside the circuit. |
| Budget | **Over 0.05 OKB.** Realistic Phase 1 deploy + demo ≈ **0.15 – 0.30 OKB** (breakdown below). Gas price is 0.02 gwei, so every 1M gas = 0.02 OKB. |

**Verdict:** the brief's Phase 1 shape ("`beforeSwap` calls the evaluator") fails the gas test as written. The design
is viable only if the hook evaluates the circuit **once, at registration**, over every possible fact word, and stores
that truth table immutably. Per swap it then does a 2-bit lookup. This is a design change and needs your decision.

## 1. Uniswap V4 on X Layer

- **PoolManager:** `0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32`.
  - Ignix's V4 PositionManager `0xcf1eafc6928dc385a342e7c6491d371d2871458b` returns it from `poolManager()`.
  - Pitchook's README lists the same address.
- **Source:**
  - Runtime code is 24,009 bytes, the same length as Ethereum's canonical PoolManager.
  - The two differ in exactly 20 bytes, at offset 13,618. That is the `NoDelegateCall` immutable holding the contract's
    own address.
  - Substituting the X Layer address into the canonical code reproduces the X Layer code exactly. So this is Uniswap's
    released v4-core, unmodified.
  - I did not check OKLink's "verified" badge. The byte comparison is the stronger evidence.
- **Owner:** `0x044aAF330d7fD6AE683EEc5c1C1d1fFf5196B6b7`. `protocolFeeController` is currently `address(0)`.
  - In v4-core the owner can only appoint the protocol-fee controller. The protocol fee is capped at 0.1% and taken on
    top of the LP fee.
  - The owner **cannot** change a pool's LP fee, its hook, or the hook's code.
- **Dynamic fees:** v4-core supports both modes, and both work on this deployment.
  - Per-swap override: `beforeSwap` returns `fee | OVERRIDE_FEE_FLAG`. This is used here, and verified on the fork.
  - Stored fee: `PoolManager.updateDynamicLPFee`, callable by the hook only.

## 2. Hook address mining

- **Flags:** V4 encodes hook permissions in the low 14 bits of the hook address. For `beforeSwap` + dynamic fee, the only
  flag is `BEFORE_SWAP_FLAG = 1 << 7`.
  - Dynamic fee is a pool property (`fee == 0x800000`), not a hook flag.
  - `BEFORE_SWAP_RETURNS_DELTA` is **not** needed. The fee override travels in the third return value.
- **Mask:** `addr & 0x3FFF == 0x0080`. Every other flag bit must be zero, or the PoolManager calls hooks the contract
  doesn't implement.
- **Cost:** 1 in 16,384 expected. Mining is a local keccak loop against the CREATE2 deployer, so it has no on-chain cost.
  Deploying the mined address is an ordinary contract deployment (below).

## 3. Pool creation

- **Initialise:** `PoolManager.initialize(key, sqrtPriceX96)` with `key.fee = 0x800000` and `key.hooks = hook`: 51.7k gas.
- **Liquidity:** a full-ish range position through `PoolModifyLiquidityTest` costs 259k–293k gas.
- **In OKB:** about 0.006 per pool with liquidity, gas only. Liquidity itself is capital, not cost; see §6.

## 4. Gas per swap (measured, steady state)

Each pool received 4 alternating 100-token swaps; the table below averages swaps 2–4. The first swap in a pool that
writes a new observation slot costs about 22k more (a zero-to-nonzero SSTORE).

| Pool | Swap gas | vs. plain | vs. plain % |
|---|---|---|---|
| No hook, static 0.30% | 124,360 | — | — |
| Hook, fixed override (hook overhead only) | 128,965 | +4.6k | +3.7% |
| Facts + **live** NetlistVM eval, 8 gates | 167,805 | +43.4k | +35% |
| Facts + **live** eval, 16 gates | 185,798 | +61.4k | +49% |
| Facts + **live** eval, 32 gates | 222,598 | +98.2k | +79% |
| Facts + live eval 16 gates + volatility observation | 191,782 | +67.4k | +54% |
| Facts + **truth table** (16-gate netlist) | 137,106 | +12.7k | +10% |
| Facts + truth table + volatility observation | 143,066 | +18.7k | +15% |

"Facts" means `getSlot0` and `getLiquidity` via `extsload`, plus one external read of an attested bit.

- **Live evaluation:**
  - A single `tierOf` call costs about 67k gas: SSTORE2 read, NetlistVM setup, then about 2.3k gas per gate.
  - The brief's three circuits (VOL_GUARD, DEPTH_GUARD, MILESTONE) evaluated separately per swap would add roughly 150k+
    gas, **more than doubling** swap cost.
  - Routers compare net output after gas, so a pool that costs 50–120% more gas per swap loses routed flow.
  - **Live per-swap evaluation is not acceptable.**
- **Truth table:**
  - The hook stores `table` (2 bits × 2^k fact words) immutably, computed from the frozen netlist by the immutable
    evaluator at registration. `tier = (table >> 2*facts) & 3`.
  - The circuit is still the whole policy. The table is a mechanical projection of it that anyone can recompute from the
    stored netlist, and the fork run confirmed the table pool charged the same fee as live evaluation.
  - One-time cost: 5.54M gas (0.11 OKB) for 7 fact bits (128 evaluations of a 16-gate netlist). With 5 fact bits
    (32 evaluations) it's about 1.4M gas (0.028 OKB).
  - **Recommendation:** at most 5 fact bits, one combined policy circuit (or three circuits sharing the 5 facts), and
    the table derived on-chain in the constructor.

## 5. Which facts are cheap in `beforeSwap`

| Fact | On-chain? | Cost | Notes |
|---|---|---|---|
| Current tick / price | Yes | ~2.1k (cold `extsload`) | `StateLibrary.getSlot0` |
| In-range liquidity ("depth") | Yes | ~2.1k | `StateLibrary.getLiquidity`. **Manipulable by JIT liquidity**: an LP can add depth in the same block to flip `DEPTH_THIN` off and get the lower tier for its own swap. Needs a time-weighted or min-over-window measure, which costs another storage slot. |
| Realised volatility | **Only if the hook records it** | +6k per swap (+22k first write) | V4 core has **no oracle/observations** (unlike V3). The hook must store its own tick history (an EWMA slot, measured above). A trader can push volatility up (raising fees for everyone, at their own cost); faking calm is harder. |
| Recent volume | Only if the hook records it | ~+5k per swap | Another accumulator slot. |
| Agent revenue (MILESTONE) | **No, needs an attestor** | ~2.6k to read | Two options: (a) read nandout's LatchFeed `REV_GE_10` bit read-only. This works for Ignix tokens only, and couples fee policy to nandout's attestor liveness and to a feed that is `Ownable2Step` by the nandout deployer. (b) Run a separate attestor with its own wallet, paying gas per post. Either way the hook needs a defined fallback tier when the fact is stale. |

## 6. Cost to deploy and demo (estimate at 0.02 gwei)

| Item | Gas | OKB |
|---|---|---|
| FeeEvaluator (immutable, ownerless) | 1.09M | 0.022 |
| FeeCircuitHook (bench hook was 1.05M; product adds netlist + table registration) | 1.2–1.5M | 0.024–0.030 |
| On-chain truth table, 5 facts (per combined circuit) | ~1.4M | ~0.028 |
| Netlist SSTORE2 writes (3) | ~0.25M | 0.005 |
| Tape-outs on the Nandout processor (3 circuits of ~8–12 gates) | +gas | ≈ 0.035 + gas: each costs gates × 0.001 OKB (transistor `mintPrice`) + 0.00066 OKB TapeOut protocol fee per mint + 0.0013 OKB `TAPEOUT_FEE`. The brief's "0.0013 per tape-out" leaves out the transistor mint. |
| 2 demo ERC-20s (or reuse existing tokens with real capital) | 1.83M | 0.037 |
| Swap router (PoolSwapTest) unless an existing V4 router is reused | 1.55M | 0.031 |
| 1–3 pools: initialize + liquidity | 0.3–0.95M | 0.006–0.019 |
| ~10 demo swaps | ~1.9M | 0.038 |
| **Total** | | **≈ 0.15 (lean: one pool, reused router/tokens) to ≈ 0.30 OKB** |

**This exceeds the ~0.05 OKB ceiling.** The nandout deploy wallet (~0.0207 OKB) is not used, and Phase 1 needs a new,
separately funded wallet. Part of the tape-out spend (`mintPrice × gates`) is paid to the Nandout processor's creator,
i.e. back to Nandout; the 0.00066 OKB per mint goes to TapeOut.

## 7. Trust posture (same as nandout)

- **Frozen netlist:** TapeOut's factory is upgradeable (`isSealed() == false`, owner `0x571d…aF15`). The hook must never
  call TapeOut's live `eval`.
  - At registration the netlist is copied (SSTORE2) and its hash checked against the taped-out circuit.
  - The table is then derived with the vendored NetlistVM (MIT, copied verbatim into `src/vendor/tapeout/`).
- **No upgrade path:** V4 hooks are immutable per pool (the hook address is part of the PoolKey). Fee tiers are
  constructor immutables. There is no owner and no setter.
- **Outside the circuit:** threshold constants for the facts live in Solidity and are immutable too. The honest claim is
  "the fee **policy** is a public, immutable circuit over public, immutable thresholds". It is not "the circuit computes
  the fee".

## Reuse

- **Pitchook** (`davieslennox0/pitchook`, private) is the existing V4 hook work on X Layer: ShieldLP, YieldDCA,
  HookFactory, Aave V3.
  - The local copy (`/root/ethonline`) has been deleted from this server, but a crontab line still runs
    `/root/ethonline/pitchook/scripts/fetch-activity.mjs` every 3 minutes and fails.
  - Its README documents a known `HookMiner` constructor-args bug in `test/YieldDCA.t.sol`. We should avoid copying that.
- **Nothing reused yet.** Phase 0 used only `v4-core` (for PoolSwapTest / PoolModifyLiquidityTest) and TapeOut's MIT
  NetlistVM + SSTORE2, copied from nandout's vendored copy.

## Reproduce

```
anvil --fork-url https://rpc.xlayer.tech --port 8548 --chain-id 196 --gas-limit 300000000
forge script script/Bench.s.sol --tc Bench --fork-url http://127.0.0.1:8548 --private-key <fork-only key> --broadcast --slow --skip-simulation
```

Gas is read from the broadcast receipts; the applied fee from the PoolManager `Swap` event's `fee` field.
