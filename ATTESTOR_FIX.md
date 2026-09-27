# Attestor fix — launch dropout + per-token freshness

Severity: correctness bug affecting fund release. AGE_GE_30D feeds UNLOCK_T2, and LatchLock releases
creator allocations on it. Launches that dropped out of Ignix's index keep stale bits while the feed
still reports fresh globally, so a release can evaluate against data that stopped updating.

## Part 1 — Persistent launch registry (attestor)
- Ignix /v1/launches now returns only the newest ~5,000 and ignores page/limit (page 2 == page 1).
  Confirm this still holds before coding; re-test the params.
- Keep a durable local registry of every launch ever seen (token, creator, pair, launchTime, first/last
  seen). Never drop an entry because it left the index.
- Each cycle: refresh in-index launches as today; for dropped-out entries refresh via
  /v1/launches/{token} and on-chain data (holders, top-10, dev outflows, LP state). If the single-launch
  endpoint also fails for a token, derive what is derivable on-chain and mark the rest unrefreshed.
- Rate limits: index allows ~600 req/min. Batch and stagger per-token refreshes; don't refresh
  every dropped-out token every cycle — prioritise (a) any token with an active lock, (b) tokens whose
  bits changed recently, (c) round-robin the rest.
- LP_PULLED stays monotonic. Never clear it during a refresh.

## Part 2 — Per-token freshness (the part that makes it fail closed)
- FIRST: inspect the DEPLOYED LatchFeed/LatchGate. Does getBits already return a per-token
  last-updated timestamp, and can LatchGate enforce per-token staleness with what is on-chain today?
- If YES: enforce per-token freshness on the gate/release path so a stale token fails closed instead
  of releasing on old bits. Add tests.
- If NO: do NOT redeploy contracts. We are 9 days from the deadline and everything is verified on
  OKLink. Instead:
  - ship Part 1 so dropout stops happening,
  - make the attestor expose per-token last-refresh in its logs and on the /launches UI,
  - write the limitation into the README trust model plainly: feed freshness is global, per-token
    staleness is mitigated by the registry, and this is the known gap.
  Report which branch you took and why.

## Tests
- A token present in the index, then absent, still gets refreshed and its bits change.
- A token with an active lock is always refreshed each cycle.
- LP_PULLED survives a refresh cycle where the source omits it.
- AGE_GE_30D is correct for a launch that left the index before crossing 30 days.

## Rules
- Do not redeploy any contract without my explicit go.
- Do not interrupt the running attestor cron for more than one cycle; deploy the fix atomically.
- Do not touch the deploy wallet (0.0207 OKB left) or the published DeWEB page.
- Report the real dropout count: how many of the ~4,000 known launches are currently outside the index.

## After the fix
Draft a short, factual bug report to Ignix about /v1/launches pagination (page/limit ignored,
5,000-item ceiling), with the reproduction. Show it to me before sending. Add a line to SUBMISSION.md
noting both ecosystem findings: this one and the TapeKit issue #6 false negative (wrong addresses
checked; X Layer SiteRegistry 0xd6ef…adb6, DomainBinding 0x6880…66f9, verified 2026-09-19).
