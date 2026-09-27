# DeWEB on X Layer: Phase 0 recon

Read-only. No transactions sent. Date 2026-09-27. All reads via `rpc.xlayer.tech` and `bsc-dataseed.bnbchain.org`.

## Verdict

**Publishing a Nandout page on X Layer is possible today.** DeWEB's site store and payment contract are
deployed on X Layer, just at different addresses from BSC. Rival entries are serving genuinely on-chain sites through
them. Estimated cost for Nandout: **~0.106 OKB** (container + one month of activation + file writes), or ~0.158 OKB with
three months. Both fit the 0.2 OKB ceiling. The deploy wallet currently holds 0.0288 OKB (+0.01 OKB withdrawable mint
proceeds), so **it needs a top-up of about 0.1 to 0.15 OKB** before Phase 1.

## 1. Contracts: eth_getCode

| Contract | X Layer (196) | code | BSC (56) | code |
|---|---|---|---|---|
| Container opener | `0x536add8f30f03b69f6fbf29d425a816a0dc50106` | 2,604 B, `FEE()` = **0.08 OKB** | `0x021745DE…81F1` | (BSC only) |
| **SiteRegistry** (UUPS proxy) | **`0xd6efb7adcc9c83dc4924ad56f6a8e4e969b9adb6`** | 176 B → impl `0xa85c4143…a45f` | `0xd006ffdd…E5e6` | 176 B |
| **DomainBinding** (UUPS proxy) | **`0x68809fd2fb343aa57d0aeb7f33defe477c9666f9`** | 176 B → impl `0x5ebf29b8…47df` | `0x861EE183…3DB7` | 176 B |
| BSC SiteRegistry address, looked up on X Layer | `0xd006ffdd…E5e6` | **0 B** | | |
| BSC DomainBinding address, looked up on X Layer | `0x861EE183…3DB7` | **0 B** | | |
| ERC-6551 registry | `0x000000006551c19487814612e58FE06813775758` | 571 B | same | 571 B |
| Container implementation | `0xAC4F791353eE9F06e2C50Ae4C34680D28Ea52a57` | 601 B | | |

**Why TapeKit issue #6 says "no code":** it checked the **BSC** addresses on X Layer. The X Layer deployment
lives at different addresses, which TapeKit's own kernel lists (`kernel/src/config.js`: "Base and X Layer … verified
2026-09-19", `registries: ['0xd6efb7…']`, `binding: '0x68809f…'`). The issue is a false negative. DeWebHub (TapeKit's
cross-chain messaging layer) isn't needed to host a site.

## 2. How the rival sites serve from chain (traced)

**`1-2-245.tapekit.org`** = circuit **#1** on X Layer (chain code **2**) processor **#245** "TapeID":

| Step | Evidence |
|---|---|
| Processor | `factory.cpuAt(245)` = `0xA93E807fAB41431827EBBa57443Fb687a95E2AA3` ("TapeID") |
| Container | `opener.accountOf(proc, 1)` = `0x75c6E2D063963561c08c838476111adda7a1a6CD`, `isOpened` = true |
| Files | `SiteRegistry.pathCount` = 7; `fileInfo("index.html")` = 10,605 B, `text/html; charset=utf-8`, sha256 `0x6812…f221` |
| Write tx | 7 `FileSet` events in blocks 71,650,558 to 71,650,578. `index.html`: tx **`0x053069ee26c42d28e0dd64bc6d417c807ace0ea1c94b282ffde2ba459e3b546b`** |
| Decoded | `putFile(0x75c6…a6CD, "index.html", "text/html; charset=utf-8", 0x6812…f221, <10,605 bytes>)` (selector `0xfab2ed82`), from `0x3699…963f` (an operator), status success, **2,457,590 gas = 0.0000492 OKB** |
| Integrity | `SiteRegistry.read(container, "index.html")` returns 10,605 bytes whose SHA-256 **equals** the declared hash |
| Activation | `DomainBinding.isLive("1.2.245.tape", container)` = true; paid until timestamp 1798192770 |

**Is tapekit.org reading X Layer or a cache?** Every subdomain returns the same 2.8 KB boot page (Cloudflare-cached)
that installs a 19.5 KB Service Worker. The worker (TapeKit `sw-gateway`, using the `kernel`) reads the files from the
chain **in the visitor's browser** and checks each against the on-chain SHA-256 (SPEC §5: at least two independent nodes
must agree). The server holds no site content. The site is served from X Layer.

Also live: processor #223 "Agent Standard Cells" (`1-2-223`) has 17 files and is activated.

## 3. Publish path (SPEC v0.2, Appendix B)

1. **Open the container:** `opener.open(processorContract, circuitId)` `payable`, `msg.value = FEE()` = **0.08 OKB**. Only the
   circuit holder can open.
2. **Write files:** `SiteRegistry.putFile(container, path, contentType, sha256, bytes)` writes the first chunk (**≤ 24,000 bytes**) and
   replaces an existing file. `appendChunk(container, path, expectIndex, bytes)` adds further chunks. Max **350 chunks = 8.4 MB per file**.
   Callable by the holder (`onlyEditor`) or an operator set with `setOperator(container, op, ttl)`.
   `setFallback(container, path)` sets a single-page-app fallback.
3. **Manifest rules:** the sha256 is declared per file. Shells read, then require length == declared size and SHA-256 == declared
   hash, or they show the file as "uploading or corrupted". An all-zero hash means "unverified". Content types are limited to
   `[A-Za-z0-9.+/;= -]`. Paths are NFC-normalised, and `/` maps to `index.html`.
4. **Activate:** `DomainBinding.bind(name, container, months)` `payable`, `msg.value = months × monthlyFee()`. On X Layer
   **monthlyFee = 0.026 OKB per 30 days** (1 to 120 months). Official shells display only activated sites (`ok`); unpaid → `unpaid`.
5. **URL:** the on-chain name is `<#ID>.<chain code>.<processor number>.tape`. X Layer is chain code 2 (SPEC is BSC-centred; X Layer
   uses the kernel's area-code form). The gateway form is `<#ID>-2-<processor>.tapekit.org`.
   **Nandout = processor 230** (`factory.cpuAt(230)` = `0x8A60…a58E`). Using circuit **#1** (BASIC_SAFETY, held by our deploy
   wallet, container `0x550046Eb68f9c5cF9D41f56ed5893B0307F4ce54`, not yet opened) gives **`1.2.230.tape` →
   `https://1-2-230.tapekit.org`**.
6. **"100% on-chain" badge (SPEC §8):** the page must reference no off-chain resources (no `http(s)://` in src, href, `url()` or
   `@import`). Links as plain `<a href>` to nandout.xyz and OKLink are navigation, but to keep the badge the page must inline its
   CSS and fonts (no Google Fonts or Fontshare).

## 4. Cost estimate for Nandout (Phase 1)

| Item | OKB |
|---|---|
| Open container (`FEE`) | 0.080 |
| Activation, 1 month / 3 months | 0.026 / 0.078 |
| File writes (~15 KB page, ~230 gas/byte observed ≈ 3.5M gas at 0.02 gwei) | ~0.0001 |
| **Total** | **~0.106 (1 mo) · ~0.158 (3 mo)** |

## 5. Trust model: new dependencies

- **SiteRegistry and DomainBinding are UUPS proxies owned by an EOA** (`0xE4fc10592FA8ad7c408B81e99CfC54Ef4B14283d`,
  no code). Not sealed: the owner can upgrade the store and the payment contract. Mitigation, by design: TapeKit's kernel
  **pins the implementation addresses** (`a85c4143…` and `5ebf29b8…` on X Layer) and refuses to read (`store-changed`)
  if they change. The `monthlyFee` can be changed (`FeeChanged` event).
- The mirror page is a **static snapshot**; nothing in Nandout's contracts depends on DeWEB. If DeWEB changes, the app on
  nandout.xyz and all Latch contracts are unaffected.
- The on-chain name is shown only while activation is paid; the files remain on chain regardless.

## 6. Can we replicate what rivals did in the time left?

Yes. It's four kinds of transaction (open, putFile ×N, bind) totalling ~0.106 OKB, and the rival TapeID site did its
7 files in 20 blocks. No custom contract is needed.

## Sources

TapeKit `SPEC.md` v0.2, `kernel/src/config.js`, `send/contracts/script/L2Addresses.sol` (github.com/TapeOutProtocol/TapeKit);
TapeKit issue #6; on-chain reads and the decoded tx above; `https://1-2-245.tapekit.org` (boot page + `/sw.js`).
