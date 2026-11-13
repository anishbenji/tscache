# N22: `clearAll`

Row N22 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Empties every cache and keeps the configs**, emitting `cacheCleared 'clear-all'` per cache; handles in every tab stay valid. Rejected: dropping the caches (live handles would fail with `UnknownCacheError` until each tab calls `cache()` again). User-confirmed 2026-10-07
