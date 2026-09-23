# Latch

> Nothing moves on Ignix until the logic says so.

Latch is built on TapeOut logic circuits on X Layer (chainId 196):

- **Latch Gate:** every Ignix launch is *latched* (untrusted) until it passes a taped-out filter circuit.
  Vaults, agents and traders call `LatchGate.check` / `checkMany` before deploying capital. Free, view-only.
- **Latch Lock:** creator allocations are held and released tranche by tranche, only when an unlock circuit passes.
  Locking enough supply sets the `LATCH_LOCKED` input bit, so locked launches pass more filters.

Free to check, pay to create.

## Status

| Package | State |
|---|---|
| `compiler/` | Rule DSL → NAND/LATCH netlist in TapeOut's format, exhaustively verified over all 2^16 inputs (×2 states for latches). |
| `contracts/` | `LatchFeed`, `LatchGate`, `LatchLock` + Foundry tests against a TapeOut mock that runs TapeOut's own NetlistVM. **Not deployed.** |
| `attestor/`, `web/`, `agent/` | Not started. |

Research on TapeOut, Ignix and X Layer: [`docs/RECON.md`](docs/RECON.md).

## Trust guarantees

**LatchLock** (holds creator tokens):
- After `createLock`, nothing about a lock can change. There is no owner, no admin withdraw, no pause, no circuit swap and no upgrade path.
- Each tranche is released **only to its beneficiary**, and only when its unlock circuit passes. Anyone may trigger a release.
- Releases evaluate the netlist **snapshotted at filter registration** with a vendored copy of TapeOut's MIT
  `NetlistVM`. TapeOut's factory is still upgradeable by its owner (`isSealed() == false`, see RECON §1.6). This path
  ignores that: a TapeOut upgrade cannot release or freeze locked funds. The test `test_release_ignoresEvilTapeOut` shows this.
- Fee: `feeBps` (constructor immutable, ≤ 100 bps; we deploy with 50) of the amount actually received, paid in kind to an
  immutable treasury.
- Liveness: releases need a fresh LatchFeed. If every attestor stops, releases wait until one resumes.
- Rebasing tokens are not supported.

**LatchGate:** no owner. `check`/`checkMany` call the live TapeOut circuit (deep integration, eval gas-capped).
`checkLocal` uses the snapshot. `verify` returns both and exposes any divergence.

**LatchFeed:** the attestor-trust boundary. Attestors report agent/revenue/LP/holder/dev-sell bits. The owner (the Latch
deploy wallet, published at deploy) can only add or remove attestors. `maxAge` is immutable. `LATCH_LOCKED` and
`AGE_*` can't be attested: LatchGate computes them on-chain. Launch time and creator are write-once.

## Input bits (uint16, little-endian pins)

| bit | name | source |
|---|---|---|
| 0 | AGENT_LINKED | attested (Ignix `asp.matched == "linked"`) |
| 1 | REV_GE_100 | attested |
| 2 | REV_GE_1000 | attested |
| 3 | LP_LOCKED | attested |
| 4 | TOP10_LT_40 | attested |
| 5 | TOP10_LT_25 | attested |
| 6 | DEV_NO_SELL_7D | attested |
| 7 | LATCH_LOCKED | **on-chain**: creator keeps ≥ `minLockBps` of supply in LatchLock |
| 8 | AGE_GE_7D | **on-chain** |
| 9 | AGE_GE_30D | **on-chain** |
| 10 | HOLDERS_GE_100 | attested |
| 11 | HOLDERS_GE_300 | attested |
| 12 | LP_PULLED | attested: graduated pair whose recognised-locker LP share fell below threshold |
| 13–15 | reserved | must be 0 |

## Circuits

Two classes:
- **Combinational filters:** pass/fail from the current inputs.
- **Latch filters:** a real TapeOut LATCH. A reset-priority SR latch: `next = NOT reset AND (set OR prev)`.
  A launch that earns trust keeps it until it breaks a rule, instead of flickering with every feed update. That's the
  name: a latch holds its state until an input flips it. X Layer has no on-chain clock for TapeOut latches. LatchGate
  stores the state and advances it with `snapshot` (≤ once per block).

| Circuit | Kind | Elements | Rule |
|---|---|---|---|
| BASIC_SAFETY | filter | 4 | LP_LOCKED ∧ TOP10_LT_40 ∧ DEV_NO_SELL_7D |
| REVENUE_AGENTS | filter | 4 | AGENT_LINKED ∧ REV_GE_100 ∧ LP_LOCKED |
| STRICT | filter | 13 | AGENT_LINKED ∧ REV_GE_1000 ∧ LP_LOCKED ∧ TOP10_LT_25 ∧ DEV_NO_SELL_7D ∧ (LATCH_LOCKED ∨ AGE_GE_30D) |
| UNLOCK_T1 | unlock | 4 | AGE_GE_7D ∧ LP_LOCKED ∧ HOLDERS_GE_100 |
| UNLOCK_T2 | unlock | 6 | AGE_GE_30D ∧ REV_GE_1000 ∧ HOLDERS_GE_300 ∧ LP_LOCKED |
| STICKY_SAFETY | latch | 11 | set: TOP10_LT_40 ∧ DEV_NO_SELL_7D ∧ HOLDERS_GE_100 · reset: ¬DEV_NO_SELL_7D ∨ LP_PULLED |

Measured in tests: `check` 36k–59k gas, `checkLocal` 27k–48k gas.

## Develop

```sh
pnpm install
pnpm compile:circuits                    # regenerates contracts/test/fixtures/circuits.json
cd contracts && forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts@v5.1.0 --no-git
forge test
cd ../compiler && pnpm test
```
