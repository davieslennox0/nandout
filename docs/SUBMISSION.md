# Nandout — Genesis Transistor Hackathon submission

**Nothing moves on Ignix until the logic says so.** Taped-out TapeOut circuits that gate Ignix launches and lock creator
allocations on X Layer.

| | |
|---|---|
| Processor (TapeOut, X Layer) | `0x8A60B4A4BCf4066F5E5F9A406fE09c5e4f52a58E`: "Nandout", processor number 230, created through TapeOut's factory |
| Transistor supply / cap / price | 500,000 / 500,000 (supply is the cap) / 0.001 OKB per transistor, fixed at deploy (see `docs/ECONOMICS.md`) |
| Circuits taped out | 6 starter circuits on processor 230 (BASIC_SAFETY, REVENUE_AGENTS, STRICT, UNLOCK_T1, UNLOCK_T2, STICKY_SAFETY) |
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

- **Ignix `/v1/launches` is capped at the newest 5,000 launches and ignores `page`, `limit`, `offset`, `cursor` and `skip`**
  (page 2 returns the same 5,000 as page 1). Any integrator reading only the index silently loses older launches. Nandout
  found this in its own attestor (45 launches had dropped out), fixed it with a durable launch registry refreshed via
  `/v1/launches/{token}`, and reported it to Ignix.
- **TapeKit issue #6 is a false negative.** It reports "no SiteRegistry / DomainBinding code on X Layer" because it checked
  the BSC addresses. On X Layer they live at SiteRegistry `0xd6efb7adcc9c83dc4924ad56f6a8e4e969b9adb6` and DomainBinding
  `0x68809fd2fb343aa57d0aeb7f33defe477c9666f9` (in TapeKit's own kernel config, verified 2026-09-19). Nandout used them to
  publish its on-chain mirror at https://1-2-230.tapekit.org.
