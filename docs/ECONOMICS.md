# Nandout economics

**Free to check, pay to create.**

## Revenue

1. **Transistor sales** from the Nandout TapeOut processor. Mint proceeds (`mintPrice × amount`) accrue to the processor
   creator (our deploy wallet) and are pulled with `Transistors.withdraw()`. Verified in the verified TapeOut source and in
   the fork test (`owed(deployer) > 0` after minting). TapeOut separately charges its own protocol fee per mint tx
   (0.00066 OKB) and a fixed tape-out fee (0.0013 OKB per circuit) that goes to TapeOut's treasury, not to us.
2. **Lock fee.** `LatchLock` takes `feeBps` of the amount it actually receives, paid in the locked token to an immutable
   treasury set at deploy. `feeBps` is a constructor immutable capped at 100 bps; we deploy with **50 bps**. No setter exists.
   The `/lock` page shows the split before signing ("Lock 10,000,000 → 9,950,000 locked, 50,000 fee (0.5%)") and
   `/treasury` lists everything the treasury holds. Fee tokens are not sold in v1.

`check` / `checkMany` are view calls and free forever. There are no subscriptions in v1.

## Processor parameters: APPROVED (2026-09-23)

TapeOut's factory takes exactly two economic parameters: `transistorSupply` (which is also the hard cap: `minted` only
goes up and burns don't return supply) and `mintPrice`. Both are fixed forever at deploy. Creating the processor costs
TapeOut's 0.0066 OKB deploy fee.

| Parameter | Value |
|---|---|
| `transistorSupply` (= cap) | **500,000** |
| `mintPrice` | **0.001 OKB** per transistor |

**How the price was set** (record date 2026-09-23, OKB ≈ $115; sources spread $110–121):
target ≈ $1 for a typical 10-gate filter → $0.10 per transistor → 0.10 / 115 = 0.00087 OKB → rounded to **0.001 OKB**.

| Circuit | Transistors | Cost in transistors | ≈ USD at $115 | USD across $110–121 |
|---|---|---|---|---|
| Typical 10-gate filter | 10 | 0.010 OKB | $1.15 | $1.10–1.21 |
| `STRICT` | 13 | 0.013 OKB | $1.50 | $1.43–1.57 |
| `BASIC_SAFETY` / `REVENUE_AGENTS` / `UNLOCK_T1` | 4 | 0.004 OKB | $0.46 | $0.44–0.48 |
| `UNLOCK_T2` | 6 | 0.006 OKB | $0.69 | $0.66–0.73 |
| `STICKY_SAFETY` | 11 (10 NAND + 1 LATCH) | 0.011 OKB | $1.27 | $1.21–1.33 |

A 10-gate filter costs 7.7× TapeOut's own 0.0013 OKB tape-out fee: cheap for a creator, but not free. **The price is in
OKB and fixed at deploy, so OKB volatility moves the USD cost.** Across the recent OKB range, typical filters stay in the
~$1–3 band targeted above (the table shows the spread).

**Supply.** 500,000 transistors is the lifetime gate budget of the processor (lifetime supply value 500 OKB). The starter
set uses 42. The ceiling leaves room for large composite circuits: Behemoth-scale designs run about 2,300 gates, and the
largest circuit on X Layer today has 3,035 (RECON §1.5).

**Launch cost** (before gas): processor 0.0066 OKB + starter set 42 × 0.001 + 7 mint txs × 0.00066 TapeOut protocol
fee + 6 × 0.0013 tape-out fee ≈ **0.061 OKB (≈ $7)**. X Layer gas is ~0.02 gwei, so deploying the four Latch
contracts costs well under 0.01 OKB. Exact figures come from a fork dry-run of `script/Deploy.s.sol` before the mainnet go.

Measured gate counts: `BASIC_SAFETY` 4, `REVENUE_AGENTS` 4, `STRICT` 13, `UNLOCK_T1` 4, `UNLOCK_T2` 6, `STICKY_SAFETY` 11.

## Demand loop

- **Every new filter or unlock circuit burns transistors** from the Nandout processor. Anyone can tape out a stricter
  filter as the ecosystem grows (thresholds are circuit-level, not protocol-level), and each one is a permanent burn.
- **Every lock** creates at least one unlock tranche against a registered unlock circuit and pays the lock fee.
  Creators have a reason to lock: it sets `LATCH_LOCKED`, which stricter filters (`STRICT`) reward.
- **Vaults and agents** read filters for free, so the more capital routes through `checkMany`, the more creators
  want to pass it, which means locking allocations and building distribution. That's the flywheel.

We tape out the starter circuits ourselves from our own processor: a disclosed burn of 42 transistors (0.042 OKB paid
to ourselves as processor creator, plus TapeOut's fees). That's not trading volume. No script in this repo trades any token or generates volume.

## Ignix integration

**Vault gate.** Before an Ignix Vault deploys into a set of launches it calls one view:

```solidity
(bool[] memory passes,) = ILatchGate(GATE).checkMany(candidates, FILTER_ID);
// deploy only into candidates[i] where passes[i]; FeedStale() reverts mean "don't deploy now"
```

The vault picks (or tapes out) the filter that matches its mandate. A conservative vault might use `BASIC_SAFETY`
(12 of 3,876 launches pass today), an agent-revenue vault `REVENUE_AGENTS`.

**Creator custody.** Ignix could route the creator allocation straight into `LatchLock.createLock(token, amount,
creator, tranches)` at launch time, with default tranches (for example 40% on `UNLOCK_T1`, 60% on `UNLOCK_T2`). The launch
starts with `LATCH_LOCKED` set, releases are evaluated by the sealed `LatchEvaluator`, and nobody (including Ignix)
can change or withdraw a lock after creation.
