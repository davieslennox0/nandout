# Nandout

> A programmable on-chain decision layer on X Layer. · [nandout.xyz](https://nandout.xyz)

Nandout turns rules into **taped-out TapeOut circuits**: NAND netlists, immutable once registered. Consumers measure
the world in Solidity, pack the facts into bits, and act on the circuit's verdict. The processor's circuits govern:
(a) whether capital should enter a token (Gate), (b) what a swap costs (fee tier), and (c) where that fee goes
(FeeRoute). Everything below shares one stack:

- **one processor:** "Nandout", TapeOut processor 230 at `0x8A60…a58E`;
- **one compiler:** `compiler/`, rule DSL → NAND netlist, verified exhaustively over every input;
- **one evaluator posture:** `LatchEvaluator`, ownerless, stateless, no proxy, evaluating frozen netlist snapshots. It
  never calls TapeOut's upgradeable contracts on the paths that move money.

| Consumer | What the circuit decides | State |
|---|---|---|
| **Gate** (`LatchGate`) | Whether an Ignix launch is *unlatched* (passes a filter). Vaults, agents and traders call `check` / `checkMany`: free, view-only. | **Live on mainnet.** The attestor scores every Ignix launch (5,144 registered on 2026-09-28) every 10 minutes. |
| **NexusHook** (`hook/`, `FeeRouteHook`) | What a swap costs (LP fee tier from volatility and scale-free depth facts) and where the fee goes (route circuits). Full circuit output precomputed at deploy, looked up per swap. | **Live on mainnet, contracts only, no pool:** [`0x9553…40cc`](https://www.oklink.com/xlayer/address/0x9553b82baf7eb83e155b33f003d89aa1d1b040cc), verified. A hostile TapeOut upgrade cannot change the tier or the destination (tested). [`docs/HOOK.md`](docs/HOOK.md) |
| **Lock** (`LatchLock`) | When a creator's locked tranche may be released. Keeping ≥ 5% of supply locked sets the `LATCH_LOCKED` bit that Gate filters read. | **Deployed, narrow in practice** (below). |

**NexusHook is live on X Layer mainnet: contracts only, no pool.** `FeeRouteHook`
[`0x9553B82Baf7EB83e155b33F003d89Aa1D1b040cc`](https://www.oklink.com/xlayer/address/0x9553b82baf7eb83e155b33f003d89aa1d1b040cc)
is verified on OKLink. Its four circuits are taped out on the Nandout processor: VOL_GUARD #7, DEPTH_GUARD #8,
ROUTE_SPLIT #9 and ROUTE_GUARD #10.

- **The hook is generic.** Any Uniswap v4 pool on X Layer can use it: create the pool with
  `fee = DYNAMIC_FEE_FLAG` and `hooks = 0x9553…40cc`.
- **LP fee.** Chosen per swap by the circuits from four fixed tiers: 0.05% / 0.30% / 0.60% / 1.00%.
- **Hook fee.** It works exactly like Uniswap's own protocol fee: **1000 pips = 0.10% of the swap input, in both
  directions**, taken before the LP fee. 1000 pips is v4's `MAX_PROTOCOL_FEE` cap, and v4 measures fees in pips, where
  1,000,000 = 100%. It is paid to one immutable address, the **Nandout deploy wallet
  `0x934d315C0a9C0866D393B722C1805F2B6b20b816`**.
- **Everything else goes to the pool's own in-range LPs.** That covers the LP fee and a 5 bps route fee on every swap.
- **Worked example.** A 1,000-token swap in the 0.30% tier pays:
  - 1.000 token hook fee to the Nandout deploy wallet;
  - 2.997 tokens LP fee (0.30% of the remaining 999) to in-range LPs;
  - a route fee of 5 bps of the output (0.4975 tokens), also to in-range LPs.
- **What the route circuits prove.** `ROUTE_SPLIT` / `ROUTE_GUARD` choose a route on every swap and emit it (`Routed`
  event), but all four routes are wired to in-range LPs. In this configuration the routing has no differential economic
  effect. What it demonstrates is that the fee *destination* is circuit-governed and immutable: nobody, including us, can
  redirect it. The tier mechanism carries the fee.
- **Why no pool.** Liquidity is capital, not gas. 13 of 49 graduated Ignix launches are untaxed into the v4 PoolManager
  and therefore poolable; all 13 reconcile exactly with this hook on a fork
  ([`docs/data/ignix-v4-tax-survey.csv`](docs/data/ignix-v4-tax-survey.csv)).

**Lock is narrow, for measured reasons:**
- **Pre-graduation tokens can't be locked.** Ignix tokens still on their bonding curve revert every transfer with
  `CurveOnly()`, so they cannot be moved into LatchLock at all. That's most launches.
- **Most creators have nothing to lock.** In our 2026-09-27 snapshot, 4,699 of 5,067 creator wallets (93%) held zero of
  their own token, and only 10 held the ≥ 5% needed for `LATCH_LOCKED`.

The share page, badge and filters work for every token; locking itself is a post-graduation feature for the few
creators who hold supply.

**General result:** any hot path can precompute a TapeOut circuit's complete output once, on-chain from the frozen
netlist, and look it up. That makes immutable circuit logic viable where per-call evaluation is not; see
[`docs/HOOK.md`](docs/HOOK.md#general-result-precompute-the-circuit-look-it-up).

**Naming:** *Nandout* is the product; *Latch* is the mechanism (a launch stays latched until a circuit unlatches it). The
contracts keep their `Latch*` names, which is how they're verified on OKLink.

## Status

| Package | State |
|---|---|
| `compiler/` | Rule DSL → NAND/LATCH netlist in TapeOut's format, exhaustively verified over all 2^16 inputs (×2 states for latches). The bit schema is a parameter: Latch bits by default, the hook's fee facts for `hook/`. |
| `contracts/` | `LatchFeed`, `LatchGate`, `LatchLock`, `LatchEvaluator`: **deployed and verified on X Layer mainnet** (addresses below). Foundry tests, plus a fork test against the real TapeOut contracts. |
| `attestor/` | Ignix index + registry + X Layer Transfer logs → attested bits → LatchFeed, on a 10-minute cron. |
| `web/` | nandout.xyz: launches, filters, per-token lock pages, badges, /lock, /creators. Built by GitHub Actions, served from our server. |
| `hook/` | NexusHook `FeeRouteHook` (extends `FeeCircuitHook`): **deployed on X Layer mainnet (no pool)**, fork tests, gas report, deploy dry-run, mainnet verifier (`attestor/scripts/verify-feeroute.mjs`). |

Research: [`docs/RECON.md`](docs/RECON.md) (TapeOut, Ignix, X Layer), [`docs/HOOK-RECON.md`](docs/HOOK-RECON.md) (Uniswap v4 on X Layer).

## Runs on X Layer, served from X Layer

Nandout runs on X Layer and is served from X Layer: a static mirror of this project lives on-chain in TapeOut DeWEB at
**https://1-2-230.tapekit.org** (on-chain name `1.2.230.tape`: circuit #1 of Nandout processor 230). The page's 8,605 bytes
are stored in X Layer's SiteRegistry and checked against their SHA-256 in the visitor's browser before display; no server
holds them. The live, dynamic app stays at [nandout.xyz](https://nandout.xyz). Details: [`docs/DEWEB-RECON.md`](docs/DEWEB-RECON.md).

## Deployed on X Layer mainnet (chainId 196)

All four Latch contracts are verified on OKLink. Deployed 2026-09-23 at block 71,426,236 from
[`0x934d…b816`](https://www.oklink.com/xlayer/address/0x934d315C0a9C0866D393B722C1805F2B6b20b816) (`contracts/deployments/196.json`).

| Contract | Address |
|---|---|
| LatchEvaluator | [`0x8cA3ecB418962801e64FF1e847a444fAB6352D03`](https://www.oklink.com/xlayer/address/0x8cA3ecB418962801e64FF1e847a444fAB6352D03) |
| LatchFeed | [`0x81Ea55c0d48fB985707eA224dC099Ff3C8f2AD78`](https://www.oklink.com/xlayer/address/0x81Ea55c0d48fB985707eA224dC099Ff3C8f2AD78) |
| LatchLock | [`0xBe9ae981ec742B9053AD802a1D6A2B96E58b67f1`](https://www.oklink.com/xlayer/address/0xBe9ae981ec742B9053AD802a1D6A2B96E58b67f1) |
| LatchGate | [`0x649373f612d278634Ba8656aF53bCA7D8dc0f940`](https://www.oklink.com/xlayer/address/0x649373f612d278634Ba8656aF53bCA7D8dc0f940) |
| Nandout processor (TapeOut Circuits) | [`0x8A60B4A4BCf4066F5E5F9A406fE09c5e4f52a58E`](https://www.oklink.com/xlayer/address/0x8A60B4A4BCf4066F5E5F9A406fE09c5e4f52a58E) |
| Nandout transistors (ERC-1155) | [`0xa5eCCEd599470f97781E3Bc10D7a380F96996aF6`](https://www.oklink.com/xlayer/address/0xa5eCCEd599470f97781E3Bc10D7a380F96996aF6) |
| Treasury (lock fees) | [`0x55116d8451Cd5326a9C1340a346BFA8604cDde58`](https://www.oklink.com/xlayer/address/0x55116d8451Cd5326a9C1340a346BFA8604cDde58) |
| Attestor | [`0xdb42fC720Af0119c9e248A0c31F3017cE0837100`](https://www.oklink.com/xlayer/address/0xdb42fC720Af0119c9e248A0c31F3017cE0837100) |

Processor: 500,000 transistors at 0.001 OKB, created through TapeOut's factory (`isCPU` = true). Filters: 1 `BASIC_SAFETY`,
2 `REVENUE_AGENTS`, 3 `STRICT`, 4 `UNLOCK_T1`, 5 `UNLOCK_T2`, 6 `STICKY_SAFETY` (latch).

## Trust model

| Component | Upgradeable? | Who can change it |
|---|---|---|
| TapeOut `CircuitFactory` + beacons (`0x1f09…0761`) | **Yes**: `isSealed() == false` | TapeOut owner EOA `0x571d…aF15` can upgrade `eval` for every processor |
| **`LatchEvaluator`** ([`0x8cA3…2D03`](https://www.oklink.com/xlayer/address/0x8cA3ecB418962801e64FF1e847a444fAB6352D03)) | **No** | Nobody. No storage, no owner, no proxy, no selfdestruct, view-only |
| `LatchLock`, `LatchGate` | No | Nobody. Immutable, ownerless |
| `LatchFeed` | No (code) | Owner can only add/remove attestors |

**`LatchEvaluator` is the sealed custody path.** It is a stateless wrapper around TapeOut's own NetlistVM (vendored
verbatim, MIT). Every LatchLock release is evaluated there, on the netlist snapshotted when the filter was registered,
and never by TapeOut's upgradeable contracts. If TapeOut upgrades its logic (or seals it), locked funds are unaffected
either way. `LatchGate.check` still calls TapeOut's live circuit, which is the integration people see; `LatchGate.verify` shows
both results and exposes any divergence.

**LatchLock** (holds creator tokens):
- After `createLock`, nothing about a lock can change. There is no owner, no admin withdraw, no pause, no circuit swap and no upgrade path.
- Each tranche is released **only to its beneficiary**, and only when its unlock circuit passes. Anyone may trigger a release.
- Releases are evaluated by **`LatchEvaluator` only**, on the netlist snapshotted at filter registration. Inputs come
  from `LatchGate.inputs` (ownerless). A TapeOut upgrade can't release or freeze locked funds:
  `test_release_ignoresEvilTapeOut` (TapeOut says "pass", nothing moves) and `test_release_independentOfTapeOut`
  (TapeOut is malicious and gas-bombing, and releases still work when the real condition holds).
- Fee: `feeBps` (constructor immutable, ≤ 100 bps; we deploy with 50) of the amount actually received, paid in kind to an
  immutable treasury.
- Unlock circuits must be **combinational**. `createLock` rejects latch filters (`StatefulUnlock`): a latch would
  carry one bad attestation forward forever, and a release is irreversible. A combinational condition always
  reflects the current attested state.
- Liveness: releases need a fresh LatchFeed. If every attestor stops, releases wait until one resumes.
- Rebasing tokens are not supported.

**LatchGate:** no owner. `check`/`checkMany` call the live TapeOut circuit (deep integration, eval gas-capped).
`checkLocal` evaluates the snapshot through `LatchEvaluator`. `verify` returns both and exposes any divergence.

**Known gap: feed freshness is global, not per token.** `LatchFeed.isFresh()` proves the attestor posted recently;
it does not prove that every token was re-evaluated. `getBits` does return a per-token `updatedAt`, but it only moves when a
token's bits change, and the deployed LatchGate/LatchLock (immutable) check only the global flag. So a token the attestor
stopped evaluating would keep old bits while the feed reads fresh. This became real when Ignix's `/v1/launches` started
returning only the newest 5,000 launches (unscoped page/limit were ignored; creator-scoped queries and `/v1/launches/{token}` did reach older ones): older launches silently dropped out of the attestor's view. As of 2026-09-28 the index no longer caps at 5,000; it returns all 5,153 launches, and the registry handles either behaviour.
Mitigation, not a contract fix: the attestor keeps a durable registry of every launch it has ever seen, recomputes the
on-chain bits (holders, top-10, dev outflows, LP) of all of them every cycle, refreshes out-of-index launches' Ignix
fields via `/v1/launches/{token}` (tokens backing a lock every cycle, the rest round-robin), and publishes per-token
freshness, shown on the Launches page. Age bits are unaffected: LatchGate computes them on-chain from the write-once launch
time. Enforcing per-token staleness on-chain would need a new LatchGate/LatchLock, which we have chosen not to redeploy
before the deadline.

**LatchFeed:** the attestor-trust boundary. Attestors report agent/revenue/LP/holder/dev-sell bits. The owner (the Latch
deploy wallet, published at deploy) can only add or remove attestors. `maxAge` is immutable. `LATCH_LOCKED` and
`AGE_*` can't be attested: LatchGate computes them on-chain. Launch time and creator are write-once.
`LP_PULLED` is final: once set, the feed keeps it set whatever later posts say (the attestor never clears it either).

## Input bits (uint16, little-endian pins)

| bit | name | source |
|---|---|---|
| 0 | AGENT_LINKED | attested (Ignix `asp.matched == "linked"`) |
| 1 | REV_GT_0 | attested: the linked agent has any recorded revenue (Ignix `asp.rev`, lifetime USD) |
| 2 | REV_GE_10 | attested: agent revenue ≥ $10 |
| 3 | LP_LOCKED | attested |
| 4 | TOP10_LT_40 | attested |
| 5 | TOP10_LT_25 | attested |
| 6 | DEV_NO_SELL_7D | attested |
| 7 | LATCH_LOCKED | **on-chain**: creator keeps ≥ `minLockBps` of supply in LatchLock |
| 8 | AGE_GE_7D | **on-chain** |
| 9 | AGE_GE_30D | **on-chain** |
| 10 | HOLDERS_GE_100 | attested |
| 11 | HOLDERS_GE_300 | attested |
| 12 | LP_PULLED | attested, **monotonic**: locked LP fell below 90% of its observed peak, or the v4 position left the locker |
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
| REVENUE_AGENTS | filter | 4 | AGENT_LINKED ∧ REV_GT_0 ∧ LP_LOCKED |
| STRICT | filter | 13 | AGENT_LINKED ∧ REV_GT_0 ∧ LP_LOCKED ∧ TOP10_LT_25 ∧ DEV_NO_SELL_7D ∧ (LATCH_LOCKED ∨ AGE_GE_30D) |
| UNLOCK_T1 | unlock | 4 | AGE_GE_7D ∧ LP_LOCKED ∧ HOLDERS_GE_100 |
| UNLOCK_T2 | unlock | 6 | AGE_GE_30D ∧ REV_GE_10 ∧ HOLDERS_GE_300 ∧ LP_LOCKED |
| STICKY_SAFETY | latch | 11 | set: TOP10_LT_40 ∧ DEV_NO_SELL_7D ∧ HOLDERS_GE_100 · reset: ¬DEV_NO_SELL_7D ∨ LP_PULLED |

Measured in tests: `check` 36k–59k gas, `checkLocal` 27k–48k gas.

**Thresholds are circuit-level, not protocol-level.** The feed carries coarse facts (any revenue, ≥ $10, ≥100 holders…);
what counts as "safe" lives in circuits. As the ecosystem grows, anyone can tape out a stricter filter and register it
on LatchGate: no redeploy, no admin, no feed change. The revenue bits were set from real data: today the best
agent-linked launch has $11.50 of agent revenue, so $100/$1,000 gates would have matched nothing.

## Findings from the first full cycle

Run over all 3,876 Ignix launches at block 71,381,515 (2026-09-23), read-only against mainnet, filters evaluated on a
local fork. Full dump: [`docs/data/bit-distribution.md`](docs/data/bit-distribution.md). These are the product working:

- **12 of 3,876 launches pass `BASIC_SAFETY`.** Only 38 have graduated to a pool at all. The largest launch
  (3,965 holders) fails: its top-10 wallets hold 64% of circulating supply.
- **With the revenue bits recalibrated** (`REV_GT_0`, `REV_GE_10`), 2 launches pass `REVENUE_AGENTS`. `STRICT` has a
  near miss: one agent-linked launch ($11.50 agent revenue, top-10 at 22.2%, no dev sells, LP locked) fails only
  `LATCH_LOCKED ∨ AGE_GE_30D`. If its creator locks 5% of supply in LatchLock, it passes. That's Gate and Lock working together.
- **The median launch is 100% concentrated** by circulating supply: most launches are one wallet (usually the dev) and
  unsold curve inventory.
- **Top-10 must be measured against circulating supply, not total supply.** Against total supply, unsold curve
  inventory made 3,865 of 3,876 launches (including dev-only tokens) look "distributed".
- **Dev-sell detection must count every creator outflow.** v4 sells route through aggregator hops, so "creator sent
  to the pool" misses them; moving supply to fresh wallets is the usual prelude to selling anyway.
- **A latch keeps what it saw.** A sticky filter fed one bad cycle kept those results until reset conditions fired.
  That is the point of a latch, and the reason unlock circuits must be combinational.

## Attestor infrastructure

The backfill reads ERC-20 `Transfer` logs for every launch since 2026-08-19 (~600k transfers, ~2,400 `eth_getLogs`
calls). Public X Layer RPCs cap log queries at 100 blocks, so development uses Ignix's RPC (`rpc.ignix.bot`, 5,000 blocks,
1,000 addresses per call). **That is a development dependency only.** Production needs a dedicated X Layer provider
with wide `eth_getLogs` ranges (`LOG_RPC_URL`), so the attestor doesn't depend on the infra of the platform it attests.
Incremental cycles fetch only new blocks (seconds). The index is checked against on-chain `balanceOf`
(`tsx src/verify-index.ts`: 0 mismatches in 272 checks on the first run).

## Build & deploy

Everything runs on our own server; builds run in GitHub Actions (`.github/workflows/ci.yml`):

- Every push and PR runs compiler/attestor/agent tests, `forge test`, and the X Layer mainnet fork test.
- On `main`, the web app is built as a Next.js standalone bundle and published to the rolling `web-latest` release.
- The server pulls it with `deploy/pull-web.sh` (cron, every 5 min): versioned directories under `/srv/nandout/releases`,
  pm2 process `nandout-web` on `127.0.0.1:8440`, Caddy serves https://nandout.xyz. GitHub never gets access to the server.
- Contract addresses reach the frontend as repository variables (`NEXT_PUBLIC_LATCH_*`) at build time.

## Develop

```sh
pnpm install
pnpm compile:circuits                    # regenerates contracts/test/fixtures/circuits.json
cd contracts && forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts@v5.1.0 --no-git
forge test
cd ../compiler && pnpm test
```
