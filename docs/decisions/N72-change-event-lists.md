# N72: How precise a change event is

Row N72 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 114 from the M7 design proposal (`docs/design/m7-change-events.md`). Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Three fields: `written` and `removed` range lists, and `cleared`.** Ranges are in ms on the grid, inclusive, ascending, disjoint and not adjacent. `written` lists the slots the call touched (N76); `removed` the coverage it actually withdrew (N82); `cleared` says everything the cache held before the call went, and `removed` is then empty while `written` lists what the same call wrote after the clear (a version-mismatch put) or nothing. A range may appear in both lists when one call did both. The lists answer a reader's one question, whether to fetch or only re-read (N84), and let it skip changes outside its view. Rejected: `{ cacheId }` only (every listener re-reads on every change of its cache, a year-long scroll-back fetch included); one hull range (cannot tell a write from a removal, and merges what one call keeps apart: a hydrate's parts, a put's write and the coverage its first watermark withdraws). User decision 65, row D2 option (c), 2026-11-16 (§2.7, step 114)
