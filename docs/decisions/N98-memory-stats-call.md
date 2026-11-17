# N98: How memory is reported

Row N98 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 121 from the M3 design proposal (`docs/design/m3-memory.md`). Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**A `memoryStats()` call, and no event.** It reports the budget in force, the counted bytes, the pinned part, the pages evicted so far and one entry per cache, ascending by id, for the engine behind the client: in a SharedWorker every tab's caches. An application that watches memory polls it on its own clock. Without a budget it walks every cache's segments, which only the caller pays. Rejected: an event when the budget is exceeded or pages are evicted (it would fire in bursts exactly when the worker is busiest). Eviction is visible to readers through `cacheChanged` (N99). User decision 67, row E15 option (a), 2026-11-16 (§2.9, step 121)
