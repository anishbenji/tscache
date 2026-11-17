# N96: How much coverage an eviction withdraws

Row N96 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 121 from the M3 design proposal (`docs/design/m3-memory.md`). Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**The page's whole slot range.** Evicting page `p` drops its segments and subtracts all of `p`'s slots from the cache's coverage in the same synchronous step, so no path can read an evicted page as a confirmed gap: a `get` over it returns no point and one `uncached` miss for the page's part of the request. The confirmed gaps on the page are forgotten with it and fetched again with the page, which keeps coverage aligned with the persisted records. Rejected: withdrawing only the extents of its segments (leaves covered slices of an evicted page for a later partial refetch to stitch). User decision 67, row E13 option (a), 2026-11-16 (§4.5, step 121)

## Clarification, 2026-11-17

The user's answer to the director's pending decision #85 (option a), from step 121's contract tests (A2): the safety rule makes a budgeted cache's coverage and covered points a subset of what an unbudgeted engine fed the same calls would answer only for a backend that answers consistently. With an inconsistent backend the budgeted cache reflects the latest put: if a page is evicted and a later put without a range omits a point the backend sent before, that point is absent inside the put's coverage, where an unbudgeted engine would still hold it from its history. This is accepted and documented, not prevented (rejected: withholding coverage from such a put, or treating it as the backend's error as N3 does). `m3-memory-engine.test.ts`, "5/A2", pins it.
