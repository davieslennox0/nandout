# DRAFT: not sent. Integration note for the Ignix team

**Subject:** Nandout: on-chain safety filters for Ignix launches (free to read), plus two integration notes

Hi Ignix team,

We built Nandout for the TapeOut Genesis Transistor hackathon. It's a set of TapeOut circuits that score every Ignix launch
on X Layer, and the results are readable on-chain by anyone for free:

- `LatchGate.check(token, filterId)` / `checkMany(tokens, filterId)` at `0x649373f612d278634Ba8656aF53bCA7D8dc0f940`
  (verified on OKLink).
- **The filters:** BASIC_SAFETY, MARKET_SAFE, REVENUE_AGENTS, STRICT and a sticky variant.
  - They combine locked LP, holder spread, dev outflows, agent revenue and age.
  - Every result comes with the conditions behind it at `nandout.xyz/lock/<token>`.
  - There's an embeddable badge at `nandout.xyz/badge/<token>.svg`.

If it's useful, a link or badge on Ignix launch pages would need no work on our side beyond what's already live.

**Two notes from integrating with your API and tokens**, offered in case they help other integrators:

1. **Pagination.** Until recently the unscoped `/v1/launches` returned the newest 5,000 launches, with `page` / `limit`
   ignored. Creator-scoped queries and `/v1/launches/{token}` reached older launches. We see it now returns all launches
   (5,153 on 2026-09-28). Documenting which query shapes paginate would help integrators.
2. **Transfer tax and Uniswap v4.** Across the 49 graduated launches, the tax on transfers into the v4 PoolManager
   (`0x360E…FB32`) is set per launch:

   | Tax | Launches |
   |---|---|
   | 0% | 13 |
   | ~1% | 20 |
   | ~2% | 7 |
   | ~3% | 6 |
   | ~10% | 1 |
   | Transfer reverts | 2 |

   v4 settles exact amounts, so taxed launches can't be added to any v4 pool; the attempt fails with
   `CurrencyNotSettled`. Creators may not realise the setting has that effect. Data:
   `docs/data/ignix-v4-tax-survey.csv` in our repo.

Thanks for building Ignix; the public API made all of this possible.

— Nandout
