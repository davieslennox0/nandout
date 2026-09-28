# Nandout: Genesis Transistor Hackathon submission

**A programmable on-chain decision layer on X Layer.** Rules are taped-out TapeOut circuits: immutable NAND netlists
evaluated by an ownerless evaluator. Consumers pack facts into bits and act on the circuit's verdict. The processor's
circuits govern whether capital should enter a token (Gate), what a swap costs (fee tier), and where that fee goes
(FeeRoute). One processor, one compiler, one evaluator posture:

- **Gate** (live): every Ignix launch is scored by filter circuits; vaults and agents call `LatchGate.check` / `checkMany`.
- **NexusHook** (live on mainnet): a generic Uniswap v4 hook, `FeeRouteHook` v2 `0xfd77af872A8f590680Fd27D79319e2e4E08E80c4`, verified on OKLink.
  - Circuits decide what a swap costs: the LP fee tier, 0.05 / 0.30 / 0.60 / 1.00%, from volatility and scale-free depth
    facts.
  - Circuits also decide where the fee goes. All routes are wired to the pool's in-range LPs, so the routing proves the
    destination is circuit-governed and immutable, without changing who is paid.
  - The circuits' full output is precomputed at deploy, and a hostile TapeOut upgrade cannot change the tier or the
    destination (tested).
  - Direction-asymmetric fee routing exists in the wild (e.g. a Solana token routing buys to a reserve and sells to
    holder payouts); our contribution is making the routing policy an immutable circuit rather than an admin setting.
  - Details: [`HOOK.md`](HOOK.md).
- **Lock** (deployed, narrow): creator allocations are released only when an unlock circuit passes. Two limits:
  - Ignix tokens cannot be locked before they graduate: every transfer reverts with `CurveOnly()`.
  - 93% of creator wallets held zero of their own token in our 2026-09-27 snapshot, so few creators have anything to lock.

## NexusHook: fee, demo pool, test lock, deprecation

**Hook fee: 1000 pips (0.10%), Uniswap v4's protocol-fee cap, taken with the mechanics of v4-core's FeeTakingHook:**
on the swap's unspecified side and on the amount that actually filled. That's the output of an exact-input swap, or the
input of an exact-output swap. It is paid to the **Nandout deploy wallet `0x934d315C0a9C0866D393B722C1805F2B6b20b816`**.
This is a different denomination from v4's own protocol fee, which is always taken from the input. Everything else goes
to the pool's own in-range LPs.

Worked example, a 1,000-token exact-input swap in the 0.30% tier:
- 3.000 LP fee to in-range LPs;
- 0.996 hook fee to the Nandout deploy wallet;
- 0.498 route fee to in-range LPs;
- the trader receives 994.51.

The hook fee and the route fee are in the output token.

**Our own demo pool, with liquidity we supplied.** This is Nandout's pool, not organic activity.
- **Pool:** native OKB / XCAT (`0xbB9A906f1A8906D548C5D94b7079fA31bF09EEee`, a graduated Ignix launch and one of the 13
  poolable ones) on FeeRouteHook v2, pool ID `0x806bfd9c404564f6f26de8355dc9a54dfab0064af57841d872124a8185a32671`.
- **Liquidity:** 0.0614 OKB + 1,649,399.07 XCAT, full range, supplied by the Nandout deploy wallet (position NFT #12817).
  We plan to withdraw it after judging (Oct 6, 04:00 UTC).
- **The XCAT:** bought in **one** open-market purchase for this demo and the test lock below
  (tx `0x0c9162c7e84c13afa3df8f6f700eff8a7fa91d8982f10fd058055cd88f13bb0a`). It will not be traded again.
- **We have made no swaps in this pool.** The hackathon rules void self-trading, so the tier evidence is:
  - read-only reads of the live pool (`currentFacts` → tier 0 → 0.05%);
  - a fork of mainnet at the live pool's state (0.05% calm → 0.60% volatile → 1.00% volatile and thin; state discarded);
  - the 32 real swaps in the fork test suite.
- **The hook fee from any swap here goes to the Nandout deploy wallet.** Swaps by anyone else will be recorded as outside
  usage. None as of this writing.

**Our own test lock.**
- **The lock:** LatchLock lock #1. 1,666,059.66 XCAT requested; **1,657,729.37 XCAT actually locked**, after LatchLock's
  0.5% fee (the transfer into LatchLock was untaxed).
- **Terms:** one tranche, 100% on UNLOCK_T1; beneficiary the Nandout deploy wallet
  (tx `0x2f7bcb3dfb0d40dfd76c07b95a8ed62b78b7306bb5b9e6a28eea4e47204e602f`).
- **`LATCH_LOCKED` stays off for XCAT,** because we are not its creator. It is a test of the lock path, not a creator lock.

**Deprecated: FeeRouteHook v1 `0x9553B82Baf7EB83e155b33F003d89Aa1D1b040cc`.**
- **The bug:** it charged the exact-input hook fee in `beforeSwap` on the amount the trader *specified*, not the amount
  that filled. A partially filled swap (price-limited, or running out of in-range liquidity) paid the fee on input that
  never swapped, and very large specified amounts reverted.
- **Status:** it stays on-chain because it is immutable (no owner, no upgrade path). **No pool ever used it.**
- **Replacement:** v2 `0xfd77af872A8f590680Fd27D79319e2e4E08E80c4`, deployed 2026-09-28, tx `0x12bbd5010ad326c03618bfefcec47dba4990b020974e0bba625f7a1bf7a22150`.
- **Regression test:** `test_partialFillPaysHookFeeOnlyOnFilledAmount`.

| Demo tx (2026-09-28, Nandout deploy wallet) | Hash |
|---|---|
| Deploy FeeRouteHook v2 (circuits #7–#10 reused) | `0x12bbd5010ad326c03618bfefcec47dba4990b020974e0bba625f7a1bf7a22150` |
| One XCAT purchase (0.127671 OKB → 3,332,119.33 XCAT) | `0x0c9162c7e84c13afa3df8f6f700eff8a7fa91d8982f10fd058055cd88f13bb0a` |
| Approve XCAT to LatchLock | `0xf28f86a8e16a328df7c86de1f0ff5445cf9235c72e979495d941898d240a3588` |
| Test lock #1 (createLock) | `0x2f7bcb3dfb0d40dfd76c07b95a8ed62b78b7306bb5b9e6a28eea4e47204e602f` |
| Approve XCAT to Permit2 | `0xe9a343467db87889ce849ab10441ac941778a93c706e0a0a0dbff15a2c9a0b7e` |
| Permit2 approve PositionManager | `0x502092ce1647d32ef2c4aa5c1832c96483c613235223c7a2b87d41cc828c978a` |
| Initialize demo pool | `0xe93a1fab2b7dcbdf7afd75defb0b45a86b7265fec6cb839aaf5c6e19826bfb08` |
| Add liquidity (position NFT #12817) | `0xebe7fc532b50a65b18961514782955b09769f652c28b53f68c9575017840887d` |

**Outside usage of the demo pool:** none recorded yet. Any swap by a third party will be listed here with its hash.


**General result:** precomputing a circuit's complete output, on-chain from the frozen netlist, makes immutable circuit
logic viable on hot paths where per-call evaluation is not.

| | |
|---|---|
| Processor (TapeOut, X Layer) | `0x8A60B4A4BCf4066F5E5F9A406fE09c5e4f52a58E`: "Nandout", processor number 230, created through TapeOut's factory |
| Transistor supply / cap / price | 500,000 / 500,000 (supply is the cap) / 0.001 OKB per transistor, fixed at deploy (see `docs/ECONOMICS.md`) |
| Circuits taped out | 11 on processor 230: 6 starters (BASIC_SAFETY, REVENUE_AGENTS, STRICT, UNLOCK_T1, UNLOCK_T2, STICKY_SAFETY), NexusHook's VOL_GUARD #7, DEPTH_GUARD #8, ROUTE_SPLIT #9, ROUTE_GUARD #10, and MARKET_SAFE #11 (Gate filter #7, registered 2026-09-28, tx `0x84c66a30117c5c3fb360051cf12b2a9069978d2cd70201bb9394a6d5fd80382e`) |
| Deploy wallet | `0x934d315C0a9C0866D393B722C1805F2B6b20b816` |
| Live app | https://nandout.xyz |
| On-chain site (DeWEB) | https://1-2-230.tapekit.org (`1.2.230.tape`) |
| Demo video | _to be added_ (script: [`DEMO-SCRIPT.md`](DEMO-SCRIPT.md)) |

## Contracts (X Layer, verified on OKLink)

LatchGate `0x649373f612d278634Ba8656aF53bCA7D8dc0f940` · LatchLock `0xBe9ae981ec742B9053AD802a1D6A2B96E58b67f1` ·
LatchFeed `0x81Ea55c0d48fB985707eA224dC099Ff3C8f2AD78` · LatchEvaluator `0x8cA3ecB418962801e64FF1e847a444fAB6352D03` ·
FeeRouteHook v2 (NexusHook) `0xfd77af872A8f590680Fd27D79319e2e4E08E80c4` · FeeRouteHook v1 `0x9553B82Baf7EB83e155b33F003d89Aa1D1b040cc` (**deprecated**, see above)

NexusHook deploy (block 71,800,736–71,800,745, from the Nandout deploy wallet; 0.021990 OKB in total, of which 0.016 OKB of
transistor proceeds are owed back to the same wallet):

| Tx | Hash |
|---|---|
| Mint 16 NAND transistors | `0x16f8b3992c95969ca88da666148001ee3bc7f0eb91bfccb0b68896a41448a308` |
| Tape out VOL_GUARD (#7) | `0x076f4f16688e6b81449bec7a21ae0f2a5e7da76cb2d1e6354670cdaf332d3add` |
| Tape out DEPTH_GUARD (#8) | `0x00985f07718691d0253d0cd5c116ab4ed6a1d932a106d3c12c3e7436a9503a69` |
| Tape out ROUTE_SPLIT (#9) | `0x82935c089ca9c7611fda435d744e2f8643857cc06903d1eaeb5f00d866519793` |
| Tape out ROUTE_GUARD (#10) | `0x05f25d290c079e7cf818ab50fbc2cc3e7803e21a66739aa358e915644b92a546` |
| Deploy FeeRouteHook **v1, now deprecated** (CREATE2, low 14 bits `0x00CC`) | `0x47143b4c923a2909de9eb38940cf70e85982f9f06d58d9319ef8a2a4b8ec46ec` |

Checked on mainnet (`attestor/scripts/verify-feeroute.mjs`):
- all four netlists are byte-identical to the compiler's output, and so are the hook's frozen copies;
- the tier and route tables match TapeOut's live `eval` for all 32 fact combinations;
- the permission bits and every configured value are as specified.

## Nandout runs on X Layer and is served from X Layer

The contracts, the processor, the circuits and the attested inputs all live on X Layer. A static mirror of the project
page is stored on X Layer too, in TapeOut DeWEB: container `0x550046Eb68f9c5cF9D41f56ed5893B0307F4ce54` of circuit #1,
file `index.html` (8,605 bytes, SHA-256 `0xb97895e31343a1c9cad60b9a84ac0d17ef2f00b69abebe8521037c572a6dac11`), activated
until 2026-12-26. The gateway serves only a boot page; the visitor's browser reads the bytes from X Layer and checks the hash.

| Step | Tx |
|---|---|
| Open container (0.08 OKB) | `0xbeb23e3c4e59253fc30e22459d1271a496b5277415740fe7d7c8ad37eb1e885f` |
| Write `index.html` (putFile) | `0xa16c3c487eb597f5f6b8d8018a7fe1c3604b087bfaf01273a36ed24fa55adbce` |
| Update `index.html` (2026-09-28: decision-layer framing, MARKET_SAFE, NexusHook) | `0x20db762eb00347d2cae5d25eec16e255335ff9562b2c415ee0a02b151faf91a0` (11,551 bytes). A malformed attempt one minute earlier, `0xbcbf84da…11d8`, wrote an empty file and was immediately superseded. |
| Update `index.html` (2026-09-28: FeeRouteHook v2, v1 deprecation, demo pool and test lock labels) | `0x410710cdca9cbbd21803910288af6722e6df025d2e4b3768f9960e3c842723fb` (13,614 bytes) |
| Activate `1.2.230.tape`, 3 months (0.078 OKB) | `0x2a4002e169e214513faac715cb01af3c68b5db52b2dd39b2fe7b9fc456777166` |

**What DeWEB should become (from doing this):** its X Layer contracts exist but are hard to find. TapeKit issue #6
concluded "no code on X Layer" because the BSC addresses were checked, while the real X Layer SiteRegistry is
`0xd6efb7ad…adb6` and DomainBinding `0x68809fd2…66f9`. Publishing chain-specific addresses in the SPEC, and sealing the
store and payment contracts (today an EOA can upgrade them; TapeKit's pin is the only guard), would make DeWEB something
other projects can build on without reverse-engineering it.

## Ecosystem findings (with receipts)

- **Ignix's unscoped `/v1/launches` index returned only the newest 5,000 launches** until 2026-09-28; it now returns all
  5,153. While capped, unscoped `page` / `limit` / `offset`
  parameters are ignored, so an integrator reading only that list silently loses older launches. Creator-scoped queries
  (`?creator=…&page=…`) do paginate, and `/v1/launches/{token}` and `/v1/launches/search` work.
  - Nandout's attestor had lost 45 launches this way. It now keeps a durable launch registry refreshed via
    `/v1/launches/{token}`.
  - We did not file a bug report: the API can already reach older launches, so this is an integration note, not a bug.
- **Pre-graduation Ignix tokens are non-transferable.** Every `transfer` / `transferFrom` reverts with `CurveOnly()`
  (selector `0x9dabc49b`), even 1 token to a plain wallet, until the token graduates to a pool. Found when the first real
  lock attempt reverted in simulation; nandout.xyz/lock now checks this before offering an approve.
- **Ignix's transfer tax into the Uniswap v4 PoolManager is set per launch, not protocol-wide.** Across all 49
  graduated launches (fork survey, `docs/data/ignix-v4-tax-survey.csv`):

  | Tax into the PoolManager | Launches |
  |---|---|
  | 0% | 13 |
  | ~1% | 20 |
  | ~2% | 7 |
  | ~3% | 6 (incl. IGNIXFROG) |
  | ~10% | 1 |
  | Transfer reverts | 2 |

  - v4 settles exact amounts, so a taxed launch cannot sit in any v4 pool, hooked or not (`CurrencyNotSettled()` on a
    fork).
  - All 13 untaxed launches pool and reconcile exactly with NexusHook's FeeRouteHook.
  - Ordinary wallet-to-wallet transfers were untaxed for every launch.
- **Uniswap v4 on X Layer is canonical v4-core.** PoolManager `0x360E…FB32` is byte-identical to Ethereum's
  `0x0000…8A90` except its 20-byte self-address immutable (checked in CI).
- **TapeKit issue #6 is a false negative.** It reports "no SiteRegistry / DomainBinding code on X Layer" because it checked
  the BSC addresses. On X Layer they live at SiteRegistry `0xd6efb7adcc9c83dc4924ad56f6a8e4e969b9adb6` and DomainBinding
  `0x68809fd2fb343aa57d0aeb7f33defe477c9666f9` (in TapeKit's own kernel config, verified 2026-09-19). Nandout used them to
  publish its on-chain mirror at https://1-2-230.tapekit.org.
