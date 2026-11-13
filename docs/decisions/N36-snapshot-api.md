# N36: Where snapshots live in the API

Row N36 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**A `get` option**: `get(range, { snapshot: true })` resolves with the result and its `snapshot`, both taken from the one engine read that follows the fetches the read awaited (§4.9), so the columns and the snapshot cannot disagree. `CacheHandle.hydrate(snapshot)` applies one; `Engine.snapshot(cacheId, range)` and `Engine.hydrate` serve persistence and tests; `hydrate` is the one new op. Rejected: two handle methods `snapshot` and `hydrate` (the server shares one client across renders, so another render's fetch, and a version change with it, can land between a render's `get` and its `snapshot`); seeds applied at `cache()` (couples opening with data and hides the result; can be layered on later). User-confirmed 2026-10-23
