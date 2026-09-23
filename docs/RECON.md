# Phase 0 — Recon

Date: 2026-09-22. Everything below was checked against X Layer mainnet (chainId 196) via `https://rpc.xlayer.tech`
or pulled from verified source / live endpoints unless marked **UNVERIFIED**.

## TL;DR

| Question | Answer |
|---|---|
| TapeOut factory on X Layer mainnet? | **Yes.** `0x1f09daefa827f02cbb40967cc91b259763760761` (ERC1967/UUPS proxy), 208 processors, 1,176 circuits live. |
| Verified source? | **Yes**, on OKLink (impl `0x74956236ab64ed143933040b4137e8a352e4d17b`, solc 0.8.24, cancun). Copied to `docs/recon/tapeout-src/`. |
| Renounced / immutable? | **NO.** `isSealed() == false`. Owner EOA `0x571d447f4f24688eC35Ccf07f1D6993655F6aF15` can upgrade the factory, **both beacons (all Transistors + all Circuits logic, incl. `eval`)**, and fees. See §1.6. |
| Eval callable from a contract? | **Yes.** `eval(uint256,bytes)` is `view`; the only external calls are `view` `circuitInfo` on REF targets, so STATICCALL-safe. |
| Programmatic tape-out? | **Yes.** `Circuits.tapeout(bytes nl, uint32 nIn, uint32 nOut) payable`, fee exactly `0.0013 OKB`. No UI needed. |
| Max input width | `nIn, nOut <= 65536`; signals are u24. Our 16 bits are trivially fine. |
| Eval gas | ~2.3k gas per gate + ~45k overhead (measured, table in §1.5). |
| Ignix launch index | `GET https://api.ignix.bot/v1/launches` — public, 600 req/60 s, 10 s cache. Schema in §2. |
| Ignix LP custody | v2: LP minted to one shared, **unverified** contract `0xed707fc375c6a27e4330d3d38a939ba55bb2b99a` (looks like a fee-harvesting locker). v4: position NFT (`lpTokenId`), holder not yet checked. |

**Decision needed from you: §4.**

---

## 1. TapeOut

### 1.1 Addresses (X Layer 196)

| What | Address |
|---|---|
| CircuitFactory (proxy) | `0x1f09daefa827f02cbb40967cc91b259763760761` (deployed ~block 70,995,047) |
| Factory impl | `0x74956236ab64ed143933040b4137e8a352e4d17b` |
| Transistor beacon → impl | `0x1059Ad62cAbB6a6925bb65aA617300556c60A51B` → `0x265bf10faB9ddEC0eE0A649C6B9DB845f1b9a06b` |
| Circuit beacon → impl | `0xf70d1ed4f62CF3780157B0b421b7E2F45bD0991C` → `0x977f217887E085D298Cb3819cDAD5A0ee35F29B2` |
| Factory owner = protocolWallet | `0x571d447f4f24688eC35Ccf07f1D6993655F6aF15` (EOA) |
| Tape-out fee treasury (constant) | `0xEBeceDeA36e598b64E17f8d519EB77441C539F76` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |

Sources: tapeout.net bundle `assets/l2-*.js` (`L2_FACTORY`) + on-chain reads + OKLink verified source.
Note: the verified impl source is the factory's compile unit. I have **not** yet byte-compared the beacon impls
against that source. The live behaviour matches it (payable `tapeout`, `TAPEOUT_FEE`, `TREASURY`). TODO in the D3 fork test.

### 1.2 Function signatures

Factory:
```
createCPU(string name, string symbol, string story, uint256 transistorSupply, uint256 mintPrice) payable
    returns (address transistors, address circuits)          // msg.value >= deployFee (currently 0.0066 OKB)
deployFee() view  -> 6.6e15 wei     protocolFee() view -> 6.6e14 wei (per mint tx, baked into each CPU at creation)
cpuCount() / cpuAt(i) / isCPU(addr)
event CPUCreated(address indexed circuits, address indexed transistors, address indexed creator, string name, uint256 supply, uint256 mintPrice)
```
- There is **no separate "cap"** parameter. `transistorSupply` *is* the cap (`supplyCap`). `minted` only increases, and burns don't return supply. So supply is the lifetime budget of gates ever taped out on the processor.
- The "processor address" is the **Circuits** clone address (ERC-721). Transistors is a paired ERC-1155 clone.
- `mintPrice` can be 0.

Transistors (ERC-1155, ids `NAND=0`, `LATCH=1`):
```
mint(uint256 id, uint256 amount) payable        // cost = mintPrice*amount + protocolFee (per tx)
withdraw()                                      // pull payments
owed(address) view
creator(), supplyCap(), minted(), mintPrice(), protocolFee()
```
**Mint proceeds:** `owed[creator] += mintPrice*amount`, `owed[protocolWallet] += protocolFee`. The creator (= the
`createCPU` caller, i.e. our deploy wallet) pulls them with `withdraw()`. **Revenue 1 is confirmed.**

Circuits (ERC-721, implements `ICPU`):
```
tapeout(bytes nl, uint32 nIn, uint32 nOut) payable returns (uint256 circuitId)   // msg.value == 0.0013 OKB exactly
eval(uint256 circuitId, bytes inputs) view returns (bytes outputs)               // reverts if circuit has latches
step(uint256 circuitId, bytes state, bytes inputs) view returns (bytes newState, bytes outputs)
circuitInfo(uint256) view returns (uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount)   // recursive counts
netlist(uint256) view returns (bytes)
nextId(), transistors(), factory(), TAPEOUT_FEE(), TREASURY()
event TapedOut(uint256 indexed circuitId, address indexed author, uint32 gateCount, uint32 nState)
```
`tapeout` burns this-layer NAND/LATCH counts **from `msg.sender`** of this processor's Transistors, then mints the NFT
to `msg.sender`. Circuit ids start at 1.

### 1.3 Netlist encoding (big-endian ints, byte stream)

Signal space: `0 = const 0`, `1 = const 1`, `2 .. 2+nIn-1 = inputs`, then each element appends new signal(s) in order.
**Outputs = the last `nOut` signals.**

| Op | Bytes | Layout |
|---|---|---|
| NAND `0x00` | 7 | `op, a:u24, b:u24`. `a` and `b` must be strictly earlier signals. |
| LATCH `0x01` | 4 | `op, d:u24`. `d` may point forward (feedback). Output = previous-cycle value. |
| REF `0x02` | 30+3·nIn | `op, cpu:address(20), circuitId:u64, nIn:u8, nOut:u8, ins:u24[nIn]`. Appends nOut signals. `cpu` must be `factory.isCPU`, and the pin counts must match. |

Reference encoder/decoder from their frontend: `docs/recon/tapeout-netlist-encoder.js`.
On-chain VM: `docs/recon/tapeout-src/lib/NetlistVM.sol` (MIT). **We can compile this into our `MockTapeOut`
directly.** That gives exact semantics, not a re-implementation.

### 1.4 Input/output bit packing

Little-endian bit order: pin `i` = `(bytes[i >> 3] >> (i & 7)) & 1`. Missing bytes read as 0.
For our uint16 `bits`: `inputs = abi.encodePacked(uint8(bits), uint8(bits >> 8))`. **Not** `abi.encodePacked(uint16)`,
which is big-endian and would swap the bytes. Output for nOut=1: `uint8(out[0]) & 1`.

### 1.5 Measured eval gas (`eth_estimateGas`, includes the 21k tx base)

| gates | nIn | netlist bytes | gas |
|---|---|---|---|
| 51 | 8 | 357 | 167,756 |
| 122 | 17 | 854 | 338,621 |
| 194 | 8 | 1,358 | 498,928 |
| 444 | 33 | 3,108 | 1,087,780 |
| 949 | 16 | 6,643 | 2,232,667 |
| 1,500 | 1 | 10,500 | 3,476,327 |

≈ **2,300 gas/gate** + fixed overhead. Our starter circuits are ~5–20 NANDs, so roughly **60–90k gas per eval**
(estimate, to confirm on fork). `checkMany(100 tokens)` ≈ 7–9M gas: fine for `eth_call`. X Layer gas price is
currently 0.02 gwei, so 1M gas ≈ 0.00002 OKB.

### 1.6 Trust model. Important.

- The factory is **UUPS-upgradeable and not sealed** (`isSealed() == false`). The owner EOA can:
  `upgradeCircuits(newImpl)` (changes `eval` for **every** processor, including ours), `upgradeTransistors`,
  `setDeployFee`, `setProtocolFee`, `setProtocolWallet`, and upgrade the factory itself. `seal()` exists but hasn't been called.
- The netlist *bytes* live in SSTORE2 pointer contracts (immutable). The code that reads and evaluates them is upgradeable.
- Consequence: the prompt's "renounced factory" assumption is **false today**. A LatchLock whose release depends on
  `Circuits.eval` inherits that upgrade key. See §4.

### 1.7 Economics observed

- Deploy fee 0.0066 OKB. Per-mint-tx protocol fee 0.00066 OKB. Per-tape-out fee 0.0013 OKB (constant in the impl).
- A sample processor uses `supplyCap=100,000`, `mintPrice=0.00066 OKB`.
- Existing circuits: most have nIn 2–32. The largest seen is 3,035 gates with 288 latches.

---

## 2. Ignix

### 2.1 Endpoints (base `https://api.ignix.bot`, from the ignix.bot Next.js bundle)

| Endpoint | Notes |
|---|---|
| `GET /v1/launches` | Returns **all** launches (3,773 today) in one response. Optional `window`, `creator`, `page`, `limit`, `status`. |
| `GET /v1/launches/{token}` | Single launch. |
| `GET /v1/skymap/agents` | OKX.AI agents: `agentId`, `rev90dUsd`, `revVerified`, `settlementCount`, `product.launchBound`, … |
| `GET /v1/dex/transactions?pool=&kind=&page=&limit=` | Trades feed. |
| `GET /v1/holdings?address=`, `/v1/founder/{token}/list` | Also exist. Not yet inspected. |

Headers: `x-ratelimit-limit: 600`, `x-ratelimit-reset: 60` (600 req/min), `cache-control: max-age=10, swr=60`.
Envelope: `{code:200, message:"success", data:{source:"pg", launches:[...]}}`.

### 2.2 Launch schema (fields we need)

```
tokenAddress, creator, createdTime (ISO), createdTx, quote,
graduated (bool), graduatedAt, venue ("v2" | "v4"),
pair (v2 pair address | null), poolId + lpTokenId (v4), splitter, taxRouter, dividendTracker, dividendBps,
holders (number, API-reported), tradeCount, progress (bonding %), lastPrice, vols{5m,1h,4h,24h,7d},
asp: null | { id: <OKX.AI agentId>, name, matched: "linked", rev: <number, USD>, mom }
```
Current population: 3,773 launches, **38 graduated** (34 v2, 4 v4), **9 with `asp`**. Oldest is 2026-08-19.
`asp.rev` is small everywhere I sampled (e.g. IMOO `0.03`), so **REV_GE_100 / REV_GE_1000 are 0 for ~all tokens today.**
**UNVERIFIED:** whether `asp.rev` is lifetime or 90-day. `skymap.rev90dUsd` is explicitly 90-day.

### 2.3 LP custody

- **Pre-graduation (≈99% of launches):** bonding curve, `pair == null`. There is no LP, so LP_LOCKED = 0 by definition.
- **v2 graduated:** at graduation the pair mints LP to `0xed707fc375c6a27e4330d3d38a939ba55bb2b99a` (unverified,
  shared by all 34 v2 pairs). It holds 47%–99.9% of each pair's LP supply (the rest is third-party LP; 1000 wei is
  burned to `0x0` by UniV2). Decoded selectors include `lock(address)`, `claim(address)`, `harvest(address)`,
  `accrued(address,address)`, `platform()`, `claimPlatform(address)`, `MANAGER()`, `owner()`, error `NotLocked()`.
  No `withdraw`/`unlock` among the decoded ones, but ~18 selectors are unknown. **Looks like a permanent fee-harvesting LP
  locker, but I cannot confirm that without source.** Pair factory: `0xDf38F24fE153761634Be942F9d859f3DBA857E95`.
  Graduation tx sender (launchpad): `0x96B51c57e5346D0C0198899243cf851D1E23C309`.
- **v4 graduated:** position NFT `lpTokenId`. Owner not yet checked (TODO).
- Detection rule proposal: `LP_LOCKED = graduated && lockerShare(pair) >= 90%` (v2), with the locker address in a
  recognised-locker list that we document. The threshold is open for discussion.

### 2.4 OKX.AI agent ↔ token

`asp.id` is the OKX.AI agent id (ERC-8004 identity registry on X Layer). `asp.matched == "linked"` is the only value
seen. Agent revenue and verification are in `/v1/skymap/agents`. How the link is created (who signs) hasn't been looked at
yet. That's needed for the agent phase (D11), not for contracts.

---

## 3. Changes this forces on the plan

1. **Input encoding:** little-endian byte packing (§1.4). `nIn = 16` is fine. Keep bits 12–15 reserved.
2. **MockTapeOut:** use the verified `NetlistVM.sol` + a minimal `Circuits`, not a hand-written evaluator.
3. **Compiler:** Yosys is **not installed** here. Our filters are shallow AND/OR/NOT trees (≤ 16 inputs), so a
   direct DSL→NAND lowering plus exhaustive 2^16 verification is simpler and deterministic. I'd keep Yosys/ABC as an
   optional optimisation pass (`apt install yosys`) and pick whichever gives fewer gates.
4. **"No gas for off-chain callers"** holds. For on-chain `release()`, budget ~100k gas per eval.
5. **Bits:** LP_LOCKED only meaningful post-graduation. REV bits will be ~all 0 today. The demo should show that honestly.
   AGE_*: token creation time isn't readable on-chain, so the launch timestamp is attested **once** (write-once
   in LatchFeed). After that, age is computed on-chain from `block.timestamp`.
6. **Hackathon "cap":** since supply = cap in this factory, ECONOMICS.md should present supply as the hard cap.

## 4. Decision needed: evaluating against an upgradeable TapeOut

LatchLock promises "immutable after creation". Today `Circuits.eval` can be changed by TapeOut's owner EOA. Options:

- **A. Call TapeOut `eval` directly (deepest integration).** Disclose the dependency in the README. If TapeOut calls
  `seal()` before the deadline, the problem goes away.
- **B. Snapshot + local VM.** At `registerFilter`, copy `netlist(id)` into LatchGate storage (or store its keccak) and
  evaluate with our own embedded copy of the MIT `NetlistVM`. The circuit is still a real taped-out TapeOut NFT, and the
  netlist is byte-identical, but release logic can't be changed by anyone.
- **C. Hybrid (my recommendation).** LatchGate `check` calls TapeOut `eval` (integration depth, and the frontend and vaults
  see TapeOut). LatchLock `release` uses the snapshotted netlist + local VM (the immutability guarantee holds).
  Optionally `check` also flags if the two ever disagree.

Also: ask the TapeOut team on the record whether/when they'll `seal()`. A public answer is useful for the judges either way.

## 5. Open items (not blocking D3)

- Byte-compare the beacon impls to the verified source (fork test).
- Fork test: STATICCALL `eval` from a contract, and measure gas for our actual starter netlists.
- v4 LP position owner; confirm the `0xed70…b99a` locker has no withdraw path (ask Ignix or decompile).
- `asp.rev` semantics; how Ignix links an agent to a token.
- Official hackathon rules page (not found by search; I used your summary).
