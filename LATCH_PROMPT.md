# NANDOUT — Build Prompt (contracts keep the Latch* prefix)

You are building **Latch** for the Ignix x TapeOut Genesis Transistor Hackathon on X Layer mainnet (chainId 196).
Deadline: 2026-10-06 05:00 UTC+1. Solo builder. Ship a working mainnet product, not a mock.

Tagline: "Latch: nothing moves on Ignix until the logic says so."

## 1. What Latch is
Two modules on one primitive (TapeOut logic circuits):
- **Latch Gate**: every token launched on Ignix is "latched" (untrusted) until it passes a taped-out filter circuit. Ignix Vaults / agents / traders call the gate before deploying capital.
- **Latch Lock**: creator token allocations are held in a vault and released only when an unlock circuit passes (revenue, holders, LP locked, time).
- The link: `LATCH_LOCKED` is an input bit to Gate filters, so launches that lock their creator allocation pass more filters.

## 2. TapeOut facts (from public sources, VERIFY in Phase 0)
- Transistor = NAND gate, ERC-1155 token, minted from a processor.
- Circuits are built by wiring transistors; "tape out" burns the transistors and mints an ERC-721 circuit whose logic is pure data.
- Primitives: NAND gates + flip-flops (1 bit of state, updated per block).
- Circuit evaluation is a read-only view call: no tx, no gas for off-chain callers, no writable state, no external calls. Gas cost is checkable before calling. Safe to evaluate untrusted circuits.
- Circuits can be used as black boxes inside other circuits.
- A permissionless, renounced factory deploys processors; all processors share the same bytecode, so circuits interoperate across processors.
- Web canvas at tapeout.net for wiring + tape out.

Hackathon requirements:
- Processor deployed on X Layer through the TapeOut factory.
- Transistor supply, unit price and any cap set and publicly disclosed at deployment.
- At least one circuit taped out on the processor before the window closes.
- Submit: processor address, deploy wallet, product demo, project description.
- Judged on: innovation, depth of TapeOut integration, completeness/UX, asset issuance design, X Layer integration, growth potential, contract security + economic model. Wash trading / self-trading = disqualification.

## 3. Phase 0 — Recon (do FIRST, write docs/RECON.md, then STOP and report to me)
1. Find the TapeOut factory on X Layer mainnet: address, verified source/ABI (OKLink X Layer explorer, tapeout.net frontend bundle, GitHub).
2. Document exact function signatures for: deploy processor (params: supply, price, cap, etc.), mint transistors, tape out a circuit (the netlist encoding format), evaluate a circuit (input/output widths, bit ordering), and any flip-flop semantics.
3. Can a Solidity contract call circuit evaluation via staticcall? What is the gas for a ~50–200 gate circuit?
4. Is there a max input width per circuit? How are inputs passed (uint, bytes, bool[])?
5. Can tape-out be done programmatically (direct contract call with an encoded netlist), or only via the canvas UI? If UI only, document the canvas import/export format.
6. Ignix data: find the public launch index the ignix.bot frontend uses (inspect network calls). Known from a third-party repo: it exposes launch entries with an `asp` object (`asp.matched === 'linked'` for OKX.AI agent-linked tokens, numeric agent IDs, `asp.rev` = agent USD revenue) and `/launch?token=` links. Document the endpoint, schema, rate limits, and fields for creator wallet, pair/LP address, launch time.
7. Confirm how an Ignix launch's LP is held (burned, locked, or a locker contract) and how to detect it on-chain.

If the factory is not on X Layer mainnet or evaluation is not callable from contracts, stop and propose a fallback before writing any other code.

## 4. Repo layout (pnpm monorepo)
- contracts/ — Foundry (Solidity ^0.8.24, OpenZeppelin)
- compiler/ — TypeScript rule compiler (rule → NAND netlist → TapeOut format)
- attestor/ — TypeScript keeper (Ignix index + X Layer RPC → LatchFeed)
- web/ — Next.js 14 app router, wagmi + viem, X Layer 196
- agent/ — OKX.AI agent tools
- docs/ — RECON.md, ECONOMICS.md, SUBMISSION.md

## 5. Input bit schema (uint16, adapt width to Phase 0 findings)
bit0  AGENT_LINKED        token linked to an OKX.AI agent (asp.matched == linked)
bit1  REV_GE_100          agent revenue >= $100
bit2  REV_GE_1000         agent revenue >= $1,000
bit3  LP_LOCKED           LP burned or in a recognised locker
bit4  TOP10_LT_40         top-10 holders (excl. LP, burn, LatchLock) < 40%
bit5  TOP10_LT_25         < 25%
bit6  DEV_NO_SELL_7D      creator wallet made no sells to the pair in the last 7 days
bit7  LATCH_LOCKED        creator allocation locked in LatchLock (computed ON-CHAIN)
bit8  AGE_GE_7D           launch age >= 7 days
bit9  AGE_GE_30D          launch age >= 30 days
bit10 HOLDERS_GE_100
bit11 HOLDERS_GE_300
bit12-15 reserved (must be 0)

Rule: bits computable on-chain (LATCH_LOCKED, AGE_*) are computed by contracts, never attested. Everything else comes from the attestor and is marked "attested" in the UI.

## 6. Contracts
**LatchFeed.sol**
- Role-gated attestor(s) write `(token, bits, blockTimestamp)` in batches. Emits `BitsUpdated`.
- `getBits(token)` returns attested bits and last update; `maxAge` config (default 30 min).
- Owner can add/remove attestors only. No other admin powers. Owner is my deploy wallet; document it.

**LatchGate.sol**
- `registerFilter(circuitRef, name)` → filterId. Permissionless; stores the circuit reference + transistor count if readable.
- `inputs(token)` merges attested bits with on-chain bits (LATCH_LOCKED from LatchLock, AGE_* from launch timestamp recorded in the feed).
- `check(token, filterId) view returns (bool pass, uint16 inputs)`. Reverts if the feed is stale. Evaluates via staticcall to the TapeOut circuit with a gas cap.
- `checkMany(tokens[], filterId)` for vaults/frontends.
- `snapshot(token, filterId)` non-view: emits `Unlatched` / `Latched` on state change for indexing.

**LatchLock.sol**
- `createLock(token, amount, beneficiary, tranches[])` where each tranche = `{unlockFilterId, bps}`; bps sums to 10000. Pull tokens via SafeERC20, record actual received (balance diff, handles fee-on-transfer).
- `release(lockId, trancheIdx)` → releases to beneficiary only if `LatchGate.check(token, filterId)` passes. Anyone can call; funds go only to the beneficiary.
- Immutable after creation: no admin withdraw, no circuit swaps, no pause, no upgradeability. This is the trust guarantee; state it in the README.
- `isLocked(token, creator)` feeds bit7.
- Deduct the 50 bps lock fee from the received amount before recording the lock; emit FeeCharged.
- ReentrancyGuard, checks-effects-interactions, events for everything.

**Tests (Foundry)**
- `MockTapeOut` implementing a NAND-netlist evaluator with the same interface found in Phase 0.
- Unit + fuzz: tranche math, staleness, gas cap, fee-on-transfer tokens, reentrancy, release to wrong address impossible.
- Fork test against X Layer mainnet with the real TapeOut circuit once one is taped out.

## 7. Compiler
- Input: a deterministic JSON rule DSL, e.g. `{"all":["AGENT_LINKED","LP_LOCKED",{"any":["REV_GE_1000","LATCH_LOCKED"]}]}`. Supports all/any/not over named bits.
- Pipeline: DSL → boolean expression → Verilog → Yosys + ABC (`abc -g NAND`) → NAND netlist → TapeOut encoding (per RECON).
- Verify: simulate the netlist against the DSL truth table for all 2^16 inputs. Fail hard on any mismatch.
- Output: netlist, transistor count, estimated eval gas, TapeOut-ready payload.
- Optional: natural-language → DSL via Claude API, always shown to the user as DSL for confirmation before tape out.

## 8. Starter circuits (tape out on our processor)
Filters:
- `BASIC_SAFETY`  = LP_LOCKED AND TOP10_LT_40 AND DEV_NO_SELL_7D
- `REVENUE_AGENTS` = AGENT_LINKED AND REV_GE_100 AND LP_LOCKED
- `STRICT`        = AGENT_LINKED AND REV_GE_1000 AND LP_LOCKED AND TOP10_LT_25 AND DEV_NO_SELL_7D AND (LATCH_LOCKED OR AGE_GE_30D)
Unlock circuits:
- `UNLOCK_T1` = AGE_GE_7D AND LP_LOCKED AND HOLDERS_GE_100
- `UNLOCK_T2` = AGE_GE_30D AND REV_GE_1000 AND HOLDERS_GE_300 AND LP_LOCKED

## 9. Attestor
- Node/TS service, cron every 10 min. Env-configured RPC, attestor key, index URL. Never commit keys.
- Sources: Ignix launch index (agent link, revenue, creator, pair, launch time); X Layer RPC/logs (LP lock state, holder distribution, creator sells to the pair).
- Holder math excludes LP pair, burn addresses, LatchLock.
- Batch writes, only for tokens whose bits changed. Logs every write with inputs used, stored as JSON for the demo.
- Document the trust assumption: revenue + distribution bits are attested; LATCH_LOCKED + age are on-chain.

## 10. Processor + economics (docs/ECONOMICS.md)
- Propose transistor supply, unit price and cap with rationale: enough transistors for ~N filter/unlock circuits at measured gate counts, and pricing that makes tape-out cheap for creators but non-trivial.
- Explain the demand loop: every new filter or unlock circuit burns transistors; more launches using Latch Lock = more burn; Ignix Vaults can subscribe to filters.
- Include an "Ignix Integration" section: exactly how an Ignix Vault calls `LatchGate.checkMany` before deploying and how Ignix could custody creator allocations via LatchLock.
- DO NOT deploy the processor or any mainnet contract without my explicit "go". Show me params + gas estimate first.

## 11. Web app
Own visual identity (dark, clean, no Ignix branding copied). Pages:
- `/` Launches: Ignix launches with latch state per filter, attested vs on-chain bit breakdown, link to the Ignix launch page.
- `/build` Filter builder: toggle bits into all/any groups → live DSL → circuit preview (gate count, transistor cost, eval gas) → tape out.
- `/lock` Create lock (token, amount, tranches with unlock circuits) + claim/release view.
- `/circuits` Registry of filters/unlocks with usage stats.
- `/docs` Integration snippet for vaults/agents (viem call to `check`).
No mock data in production views; show empty states honestly.

## 12. Agent (OKX.AI)
- Recon how agents are deployed on OKX.AI and how Ignix links an agent to a token; document in RECON.md.
- Tools: `check_token(token, filter)`, `list_unlatched(filter)`, `explain_latch(token)` (human-readable reasons per bit), `lock_guide(token)`.
- NO auto-trading in v1. NEVER write any script that trades our own tokens or generates volume.

## 13. Hard rules
- Mainnet only for the final product; testnet/fork for development.
- Ask before spending any funds or deploying.
- No secrets in git. `.env.example` only.
- Don't invent addresses, ABIs or endpoints; if unknown, say so and stop.
- Patch-style edits; keep commits small and descriptive.

## 14. Milestones
- D1–2: Phase 0 recon → RECON.md → report to me.
- D3–5: compiler + MockTapeOut + contracts + tests.
- D6–7: attestor on fork, then mainnet read-only.
- D8–9: web app.
- D10: my go → deploy processor, tape out starter circuits, deploy Latch contracts, start the attestor.
- D11: agent tools; get 1–2 external builders to tape out a filter.
- D12: demo video script + docs/SUBMISSION.md (processor address, deploy wallet, demo link, description).
- D13: buffer, submit.

Start with Phase 0 now.

## 15. Fee model
- `check` / `checkMany`: free forever (view calls).
- Revenue 1: transistor sales from our processor (confirm in Phase 0 whether mint proceeds route to the deployer).
- Revenue 2: LatchLock creation fee = 50 bps of the actual received amount, paid in-kind to an immutable treasury address set at deploy. Fee bps is a constructor immutable, max 100 bps, no setter.
- Document both in ECONOMICS.md with the line: "Free to check, pay to create."
- No subscriptions in v1.
- /lock UI must show the fee before signing: "Lock 10,000,000 → 9,950,000 locked, 50,000 fee (0.5%)".
- Treasury receives many small launch tokens; add a read-only /treasury page listing holdings (transparency for judges). No auto-selling of fee tokens in v1.

## 17. Stateful latch circuits (differentiator)
- Add a second circuit class: STATEFUL filters using TapeOut flip-flops, alongside the combinational ones.
- Semantics: SET when pass conditions hold; RESET (re-latch) on a violation bit (DEV_SELL, LP_PULLED, TOP10 concentration rising past threshold). State persists across blocks — a launch that earns trust keeps it until it breaks a rule, rather than flickering with feed staleness.
- Document why this matches the name: a latch holds state until an input flips it.
- Build one stateful starter circuit: STICKY_SAFETY (set on CURVE_SAFETY, reset on DEV_SELL or LP_PULLED).
- Verify flip-flop semantics in Phase 0 notes before wiring; if per-block update makes state unusable for our cadence, document why and keep combinational.

## 18. Post-data decisions
- Rename bit1 REV_GE_100 -> REV_GT_0 (agent has any recorded revenue); bit2 REV_GE_1000 -> REV_GE_10. Update README bit table, starter filters, compiler fixtures and tests.
- STRICT and REVENUE_AGENTS use REV_GT_0. Document in README: thresholds are circuit-level, not protocol-level — anyone can tape out a stricter revenue filter as the ecosystem grows, with no redeploy.
- LatchLock MUST reject stateful (latch) filters as unlock circuits. Enforce in registerFilter metadata + a require in createLock, with a test. Rationale: a latched bad attestation would release funds irreversibly; combinational unlock conditions always reflect current attested state.
- LP_PULLED stays monotonic: once set, never cleared by the attestor.
- README "Findings" section: 12/3,876 pass BASIC_SAFETY, median launch is 100% concentrated by circulating supply, dev-sell detection must count all creator outflows because v4 sells route through aggregators, and top-10 must be measured against circulating not total supply. These are the product working.
- Production RPC: rpc.ignix.bot is a dev dependency only; document the need for a dedicated X Layer provider for the attestor backfill.

## 19. Rename
- Product name is **Nandout**, at nandout.xyz. Use it in README, frontend, demo, SUBMISSION.md and the agent listing.
- Contract names keep the Latch* prefix (LatchGate, LatchLock, LatchFeed, LatchEvaluator) — "latch" is the mechanism, "Nandout" is the product. Do not rename contracts; they are test-covered and will be verified on OKLink under these names.
- README must state this once so judges aren't confused by the two names.

## 20. Split out LatchEvaluator
- Extract the netlist evaluator from LatchGate into `LatchEvaluator.sol`: immutable, ownerless, no proxy, no selfdestruct, pure/view only.
- LatchGate and LatchLock both hold its address as an immutable constructor arg.
- LatchLock's release path calls LatchEvaluator ONLY. LatchGate.check still calls TapeOut live eval; LatchGate.checkLocal calls LatchEvaluator.
- README "Trust model": name the deployed LatchEvaluator address as the sealed custody path, contrasted with TapeOut factory isSealed() == false.
- Keep test coverage: the malicious-upgrade test must still prove no funds move.

## 22. Approved processor params (supersedes §21)
- Supply / cap: 500,000 transistors.
- Unit price: 0.001 OKB per transistor (NOT 0.0001).
- Arithmetic for ECONOMICS.md (record date 2026-09-23, OKB ~ $115, sources spread $110-121):
  target ~$1 per 10-gate filter -> $0.10/transistor -> 0.10 / 115 = 0.00087 OKB -> round to 0.001 OKB.
  10-gate filter = 0.01 OKB (~$1.15), 7.7x TapeOut's 0.0013 OKB tape-out fee.
  STRICT (13 gates) = 0.013 OKB (~$1.50). Lifetime supply value = 100 OKB (~$11,500).
- State in ECONOMICS.md that price is fixed at deploy and OKB volatility moves the USD cost; the $1-3 band holds across the recent OKB range.
- FINAL: supply/cap 500,000 @ 0.001 OKB. 10-gate filter = 0.01 OKB (~$1.15); STRICT (13 gates) = 0.013 OKB (~$1.50). Gate ceiling 500,000 leaves headroom for large composite circuits (Behemoth-scale is 2,300 gates). Lifetime supply value 500 OKB.
