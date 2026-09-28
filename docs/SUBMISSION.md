# Nandout: Genesis Transistor Hackathon submission

**A programmable on-chain decision layer on X Layer.** Rules are taped-out TapeOut circuits: immutable NAND netlists
evaluated by an ownerless evaluator. Consumers pack facts into bits and act on the circuit's verdict. One processor, one
compiler, one evaluator posture, three consumers:

- **Gate** (live): every Ignix launch is scored by filter circuits; vaults and agents call `LatchGate.check` / `checkMany`.
- **NexusHook** (fork-proven, not deployed): a Uniswap v4 hook whose LP fee tier comes from two taped-out circuits.
  - The full output is precomputed at registration, so each swap pays +9.8% gas instead of +53% for live evaluation.
  - It survives a malicious TapeOut upgrade (tested).
  - Details: [`HOOK.md`](HOOK.md).
- **Lock** (deployed, narrow): creator allocations are released only when an unlock circuit passes. Two limits:
  - Ignix tokens cannot be locked before they graduate: every transfer reverts with `CurveOnly()`.
  - 93% of creator wallets held zero of their own token in our 2026-09-27 snapshot, so few creators have anything to lock.

**General result:** precomputing a circuit's complete output, on-chain from the frozen netlist, makes immutable circuit
logic viable on hot paths where per-call evaluation is not.

| | |
|---|---|
| Processor (TapeOut, X Layer) | `0x8A60B4A4BCf4066F5E5F9A406fE09c5e4f52a58E`: "Nandout", processor number 230, created through TapeOut's factory |
| Transistor supply / cap / price | 500,000 / 500,000 (supply is the cap) / 0.001 OKB per transistor, fixed at deploy (see `docs/ECONOMICS.md`) |
| Circuits taped out | 6 starter circuits on processor 230 (BASIC_SAFETY, REVENUE_AGENTS, STRICT, UNLOCK_T1, UNLOCK_T2, STICKY_SAFETY). NexusHook's VOL_GUARD / DEPTH_GUARD are taped out on the same processor in fork tests only. |
| Deploy wallet | `0x934d315C0a9C0866D393B722C1805F2B6b20b816` |
| Live app | https://nandout.xyz |
| On-chain site (DeWEB) | https://1-2-230.tapekit.org (`1.2.230.tape`) |
| Demo video | _to be added_ |

## Contracts (X Layer, verified on OKLink)

LatchGate `0x649373f612d278634Ba8656aF53bCA7D8dc0f940` · LatchLock `0xBe9ae981ec742B9053AD802a1D6A2B96E58b67f1` ·
LatchFeed `0x81Ea55c0d48fB985707eA224dC099Ff3C8f2AD78` · LatchEvaluator `0x8cA3ecB418962801e64FF1e847a444fAB6352D03`

## Nandout runs on X Layer and is served from X Layer

The contracts, the processor, the circuits and the attested inputs all live on X Layer. A static mirror of the project
page is stored on X Layer too, in TapeOut DeWEB: container `0x550046Eb68f9c5cF9D41f56ed5893B0307F4ce54` of circuit #1,
file `index.html` (8,605 bytes, SHA-256 `0xb97895e31343a1c9cad60b9a84ac0d17ef2f00b69abebe8521037c572a6dac11`), activated
until 2026-12-26. The gateway serves only a boot page; the visitor's browser reads the bytes from X Layer and checks the hash.

| Step | Tx |
|---|---|
| Open container (0.08 OKB) | `0xbeb23e3c4e59253fc30e22459d1271a496b5277415740fe7d7c8ad37eb1e885f` |
| Write `index.html` (putFile) | `0xa16c3c487eb597f5f6b8d8018a7fe1c3604b087bfaf01273a36ed24fa55adbce` |
| Activate `1.2.230.tape`, 3 months (0.078 OKB) | `0x2a4002e169e214513faac715cb01af3c68b5db52b2dd39b2fe7b9fc456777166` |

**What DeWEB should become (from doing this):** its X Layer contracts exist but are hard to find. TapeKit issue #6
concluded "no code on X Layer" because the BSC addresses were checked, while the real X Layer SiteRegistry is
`0xd6efb7ad…adb6` and DomainBinding `0x68809fd2…66f9`. Publishing chain-specific addresses in the SPEC, and sealing the
store and payment contracts (today an EOA can upgrade them; TapeKit's pin is the only guard), would make DeWEB something
other projects can build on without reverse-engineering it.

## Ecosystem findings (with receipts)

- **Ignix's unscoped `/v1/launches` index returns only the newest 5,000 launches.** Unscoped `page` / `limit` / `offset`
  parameters are ignored, so an integrator reading only that list silently loses older launches. Creator-scoped queries
  (`?creator=…&page=…`) do paginate, and `/v1/launches/{token}` and `/v1/launches/search` work.
  - Nandout's attestor had lost 45 launches this way. It now keeps a durable launch registry refreshed via
    `/v1/launches/{token}`.
  - We did not file a bug report: the API can already reach older launches, so this is an integration note, not a bug.
- **Pre-graduation Ignix tokens are non-transferable.** Every `transfer` / `transferFrom` reverts with `CurveOnly()`
  (selector `0x9dabc49b`), even 1 token to a plain wallet, until the token graduates to a pool. Found when the first real
  lock attempt reverted in simulation; nandout.xyz/lock now checks this before offering an approve.
- **Ignix tokens tax the Uniswap v4 PoolManager.** A graduated launch (IGNIXFROG) takes 3% on transfers to and from its
  v2 pair and the v4 PoolManager, but not on ordinary transfers. v4 settles exact amounts, so no v4 pool (hooked or not)
  can hold an Ignix token: `CurrencyNotSettled()` on a fork (`hook/test/IgnixFrogPool.fork.t.sol`).
- **Uniswap v4 on X Layer is canonical v4-core.** PoolManager `0x360E…FB32` is byte-identical to Ethereum's
  `0x0000…8A90` except its 20-byte self-address immutable (checked in CI).
- **TapeKit issue #6 is a false negative.** It reports "no SiteRegistry / DomainBinding code on X Layer" because it checked
  the BSC addresses. On X Layer they live at SiteRegistry `0xd6efb7adcc9c83dc4924ad56f6a8e4e969b9adb6` and DomainBinding
  `0x68809fd2fb343aa57d0aeb7f33defe477c9666f9` (in TapeKit's own kernel config, verified 2026-09-19). Nandout used them to
  publish its on-chain mirror at https://1-2-230.tapekit.org.
