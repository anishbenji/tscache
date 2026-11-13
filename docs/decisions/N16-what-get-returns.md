# N16: What `get` returns

Row N16 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Every present point in the request**, covered or not; `coverage` marks the authoritative parts. Needed for the live tail, whose slots are never covered yet whose last candle must show, and it keeps an invalidated range on screen until the refetch replaces it. Rejected: only points inside coverage (nothing stale ever shows, but the volatile region would need a special case and an invalidated range would go blank until refetched). User-confirmed 2026-10-06
