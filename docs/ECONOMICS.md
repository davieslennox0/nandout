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

## Processor parameters: PROPOSAL, pending your "go"

TapeOut's factory takes exactly two economic parameters: `transistorSupply` (which is also the hard cap: `minted` only
goes up and burns don't return supply) and `mintPrice`. Creating the processor costs a 0.0066 OKB deploy fee.

| Parameter | Proposed | Rationale |
|---|---|---|
| `transistorSupply` (= cap) | **100,000** | Starter set burns 42 transistors (41 NAND + 1 LATCH). Typical filters are 4–15 gates, so the supply covers ~5,000–10,000 filters/unlock circuits. It's scarce enough to matter and large enough to never block a creator during the hackathon. Same order as other X Layer processors (a sampled one uses 100,000). |
| `mintPrice` | **0.0001 OKB** / transistor | A 4-gate filter costs 0.0004 OKB in transistors, a 13-gate `STRICT` 0.0013 OKB. That's the same order as TapeOut's own fixed fees (0.00066 + 0.0013 OKB), so tape-out is cheap but not free. Max lifetime revenue at full supply: 10 OKB. |

Measured gate counts behind this: `BASIC_SAFETY` 4, `REVENUE_AGENTS` 4, `STRICT` 13, `UNLOCK_T1` 4, `UNLOCK_T2` 6,
`STICKY_SAFETY` 11 (10 NAND + 1 LATCH).

Launch cost (estimate, before gas): processor 0.0066 OKB; starter set 42 × 0.0001 + 7 mint txs × 0.00066 + 6 ×
0.0013 ≈ 0.0166 OKB. X Layer gas is ~0.02 gwei, so deploying all four Latch contracts costs well under 0.01 OKB.
Exact figures come from a fork dry-run of `script/Deploy.s.sol` before the mainnet go.

## Demand loop

- **Every new filter or unlock circuit burns transistors** from the Nandout processor. Anyone can tape out a stricter
  filter as the ecosystem grows (thresholds are circuit-level, not protocol-level), and each one is a permanent burn.
- **Every lock** creates at least one unlock tranche against a registered unlock circuit and pays the lock fee.
  Creators have a reason to lock: it sets `LATCH_LOCKED`, which stricter filters (`STRICT`) reward.
- **Vaults and agents** read filters for free, so the more capital routes through `checkMany`, the more creators
  want to pass it, which means locking allocations and building distribution. That's the flywheel.

We tape out the starter circuits ourselves from our own processor. That's a disclosed burn of 42 transistors, not
trading volume. No script in this repo trades any token or generates volume.

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
