# N96: How much coverage an eviction withdraws

Row N96 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 121 from the M3 design proposal (`docs/design/m3-memory.md`). Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**The page's whole slot range.** Evicting page `p` drops its segments and subtracts all of `p`'s slots from the cache's coverage in the same synchronous step, so no path can read an evicted page as a confirmed gap: a `get` over it returns no point and one `uncached` miss for the page's part of the request. The confirmed gaps on the page are forgotten with it and fetched again with the page, which keeps coverage aligned with the persisted records. Rejected: withdrawing only the extents of its segments (leaves covered slices of an evicted page for a later partial refetch to stitch). User decision 67, row E13 option (a), 2026-11-16 (§4.5, step 121)
