# DRAFT — not sent. Bug report for Ignix: /v1/launches pagination

**Title:** `/v1/launches` returns only the newest 5,000 launches; `page` / `limit` are ignored

**What happens**
`GET https://api.ignix.bot/v1/launches` returns exactly 5,000 launches (newest first; oldest `createdTime` on
2026-09-27 was 2026-08-21T13:08Z). Adding `page`, `limit`, `offset`, `cursor`, `skip`, `before`, `sort`, `order`,
`status=all` or `window=all` returns the same 5,000 items. There is no way to list launches older than the newest 5,000.

**Reproduction** (2026-09-27 ~17:00 UTC)
```
curl -s 'https://api.ignix.bot/v1/launches'            | jq '.data.launches | length'   # 5000
curl -s 'https://api.ignix.bot/v1/launches?page=2'     | jq '.data.launches | length'   # 5000, identical set
curl -s 'https://api.ignix.bot/v1/launches?limit=10'   | jq '.data.launches | length'   # 5000
curl -s 'https://api.ignix.bot/v1/launches?offset=5000'| jq '.data.launches | length'   # 5000
```
Comparing page 1 and page 2 token addresses: 5,000 of 5,000 overlap.

**Expected**
Either working pagination (`page`/`limit` or a cursor) over all launches, or documentation of the cap. The frontend code
already sends `page`, `limit`, `creator` and `status`, which suggests pagination was intended.

**Impact**
Integrators that read the index lose older launches silently once total launches pass 5,000. We attest Ignix launches
on-chain for LatchGate/LatchLock on X Layer. 45 launches had dropped out of our view before we noticed. We now keep our
own registry and refresh older launches via `/v1/launches/{token}`, which still works. Note that this endpoint returns
`holders` as a top-holder list and the count as `holderCount`, unlike the index where `holders` is the count.

**Contact:** Nandout (nandout.xyz)
