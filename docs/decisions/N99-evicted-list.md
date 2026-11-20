# N99: How `cacheChanged` reports an eviction

Row N99 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 121 from the M3 design proposal (`docs/design/m3-memory.md`). Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**A separate, optional `evicted` list on `cacheChanged`, which needs no re-read.** The data did not change, so a view's copy is still right; a view that reads the range later fetches it as any miss. Only the coverage actually withdrawn is listed (as N82 for `removed`), so evicting a page that holds points but no coverage sends nothing. An eviction belongs to the report of the call whose enforcement ran it: one event per cache per call (N73), the call's own cache with its `written` and its `evicted`, another cache's with `evicted` only, under the same `requestId`; an enforcement at a get's pin release reports under that get's `requestId`. The field is absent when the call evicted nothing, so without a budget the payload is unchanged. Rejected: reporting eviction in `removed` (every view showing the range would refetch it and evict other views' pages in turn: thrash) and not reporting it. User decision 67, row E16 option (a), 2026-11-16 (§2.7, step 121)
