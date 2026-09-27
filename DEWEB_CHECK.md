# DeWEB on X Layer — recon, then (maybe) publish Nandout on-chain

Context: Nandout is live on X Layer mainnet (processor 0x8A60B4A4BCf4066F5E5F9A406fE09c5e4f52a58E, site at nandout.xyz).
Ignix's hackathon call ends with "show us what you think DeWEB should become". DeWEB is TapeOut's on-chain
website layer: a circuit's ERC-6551 container holds the site files, and TapeKit serves them with no server
and no DNS (e.g. 1-2-245.tapekit.org). Several rival entries already serve from chain; we do not.

Goal: find out whether we can publish a Nandout page into a container on X Layer, and if so, do it.

## Phase 0 — Recon only. Write docs/DEWEB-RECON.md, then STOP and report.
Do NOT send any transaction in this phase.

1. Check for deployed code (eth_getCode) on X Layer (196) for: SiteRegistry, DomainBinding, DeWebHub,
   container opener 0x536add8f30f03b69f6fbf29d425a816a0dc50106 (reported FEE 0.08 OKB).
   Compare with BSC (56): SiteRegistry 0xd006ffdd5Ae313B17729621A00999cD3C71CE5e6,
   DomainBinding 0x861EE183de2BBE4a6ecf9D15812C123b566a3DB7.
   Source of these addresses: github.com/TapeOutProtocol/TapeKit issue #6 (4 days old) which claims
   SiteRegistry/DomainBinding have NO code on X Layer. VERIFY against chain — it may have shipped since.
2. Contradiction to resolve: these X Layer entries appear to serve live on-chain sites —
   github.com/JogJohgoeg/tapeid (1-2-245.tapekit.org, processor #245),
   github.com/IGNIX-IMOO/skillpass (1-2-223.tapekit.org, processor #223),
   github.com/tizerluo/neon-reliquary-xlayer.
   Determine exactly HOW: which contract holds their files, which tx wrote them, and whether
   tapekit.org is reading from X Layer or from a gateway cache. Trace one of their sites to the
   actual on-chain write tx and decode it.
3. Document the full publish path if one exists: open container (fee), write files
   (putFile / appendChunk or equivalent), size limits per file and per tx, total gas/OKB cost,
   SHA-256 manifest rules, and how the resulting URL is derived.
4. Read TapeKit's SPEC.md / repo docs for the file format the gateway expects.
5. Report: is publishing possible on X Layer today? Cost estimate in OKB. Any dependency on a
   contract that is upgradeable or unsealed (note it for our trust-model section).

## Phase 1 — only after my explicit go
Publish a STATIC read-only Nandout page into a container owned by one of our existing circuits.
- Content: the Nandout pitch, live pass counts baked in at publish time (state they are a snapshot and
  give the block), the four contract addresses with OKLink links, the trust model table, and a link to
  nandout.xyz for the live app. No JS that needs a server. Keep it small; report byte size before writing.
- The dynamic app stays on nandout.xyz. This is an on-chain mirror, not a migration.
- Verify after publish: fetch the served URL, confirm bytes match the on-chain SHA-256, record the
  write tx hashes.
- Add to README + SUBMISSION.md: "Nandout runs on X Layer and is served from X Layer", with the URL.

## If publishing is NOT possible on X Layer
Do not force it. Write the finding up in docs/DEWEB-RECON.md with the eth_getCode evidence and the
tx-level trace from step 2, and add a short section to SUBMISSION.md stating what DeWEB needs on
X Layer for Nandout to be served on-chain. A documented blocker with receipts is a legitimate answer
to "what should DeWEB become".

## Rules
- Phase 0 is read-only. No transactions, no container opening, no fees, without my go.
- Budget ceiling for Phase 1 if approved: 0.2 OKB total. Stop and report if it would exceed that.
- Use the nandout deploy wallet only if I approve Phase 1; never the attestor key.
- Do not pause or break the running attestor or the site deploy cron.
- Report honestly if the competitor sites turn out to be doing something we cannot replicate in 9 days.
