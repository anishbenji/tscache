# N46: When stored records load (P2)

Row N46 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Eagerly, when the cache opens**: one read-only transaction for the cache record and every page, and `cache()` resolves after they are applied (at most 5 s), so a reload's first `get` is served from them. The page keys `[cacheId, page]` and `PersistStore.read(id, pages)` leave room for lazy loading. Rejected for now: lazy loading on first read (an asynchronous step inside `get`, which needs its own atomicity design); a byte budget for the eager part (needed with eviction). Measured: `getAll` of 16 pages, a year at one minute, 6.8 ms. Director, 2026-10-30
