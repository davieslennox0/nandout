# Demo video script (target 2:30–3:00)

Record at 1920×1080 with a browser, OKLink and a terminal. The narration is written to be read at a normal pace, and
every on-screen claim can be checked live. Numbers are as of 2026-09-28; re-read them on screen when recording.

---

**0:00 – 0:15 · Hook**
*Screen:* nandout.xyz home, then a slow scroll over the circuit cards.
> "Nandout is a programmable decision layer on X Layer. Rules are TapeOut circuits: real NAND netlists, immutable once
> they're taped out. Anything on-chain can ask them a yes-or-no question for free, and nobody, including us, can quietly
> change the answer."

**0:15 – 0:50 · Gate: should capital enter this launch?**
*Screen:* the launches list. Pick a launch that passes MARKET_SAFE (for example TAPEOUTX `0x16aa…EEEE`) and open
`nandout.xyz/lock/<token>`.
> "Our attestor scores every Ignix launch, over five thousand of them, every ten minutes: locked LP, holder spread, dev
> selling, agent revenue. Each filter is a circuit. Here's why this token passes MARKET_SAFE and fails STRICT: every
> result shows the exact conditions behind it."

*Screen:* terminal, one line:
```
cast call 0x649373f612d278634Ba8656aF53bCA7D8dc0f940 "check(address,uint256)(bool,uint16)" <token> 7 --rpc-url https://rpc.xlayer.tech
```
> "The same answer on-chain, from LatchGate. A vault or an agent calls this before it deploys capital."

**0:50 – 1:40 · NexusHook: what a swap costs, and where the fee goes**
*Screen:* OKLink, FeeRouteHook `0x9553B82Baf7EB83e155b33F003d89Aa1D1b040cc` → Contract tab (verified source).
> "NexusHook is a Uniswap v4 hook on X Layer. Four more circuits decide the LP fee tier, from volatility and depth measured
> against each pool's own baseline, and where the fee goes. Evaluating circuits on every swap costs up to 55% more gas, so
> we computed each circuit's full output once, at deploy, from the frozen netlist. Each swap looks it up."

*Screen:* terminal: `cd hook && forge test --mt test_maliciousTapeOutUpgradeCannotChangeTierOrDestination -vv` (fork).
> "TapeOut's factory is upgradeable. This test replaces the processor with a hostile one. The live path is compromised, and
> every fee tier and fee destination stays exactly the same."

*Screen:* HOOK.md worked example.
> "The hook's own fee is disclosed and fixed: 0.1% of the input, Uniswap's own protocol-fee cap, paid to our named deploy
> wallet. Everything else goes to the pool's LPs."

**1:40 – 2:10 · Findings from building it**
*Screen:* `docs/data/ignix-v4-tax-survey.csv`, then the SUBMISSION findings list.
> "Building this surfaced real facts about the ecosystem. Ignix's transfer tax into v4 is set per launch: 13 of 49
> graduated launches can sit in a v4 pool, and the rest can't. Tokens still on their bonding curve can't be transferred at
> all, which is why locking is a post-graduation feature. We publish those limits instead of hiding them."

**2:10 – 2:35 · Served from X Layer, and close**
*Screen:* https://1-2-230.tapekit.org loading (the page is verified against its SHA-256 in the browser), then back to
nandout.xyz.
> "Even this page is stored on X Layer. Nandout: rules as circuits, one processor, one compiler, one ownerless evaluator,
> and consumers that act on the verdict. Nothing moves until the logic says so."

---

Checklist before recording:
- [ ] re-read the launch counts and the chosen token's filter results from the live site;
- [ ] run the fork test beforehand so its output is cached (it compiles for ~90 s the first time);
- [ ] after upload, put the link in `docs/SUBMISSION.md` (Demo video row).
