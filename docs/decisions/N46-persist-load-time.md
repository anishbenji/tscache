# N46: When stored records load (P2)

Row N46 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Eagerly, when the cache opens**: one read-only transaction for the cache record and every page, and `cache()` resolves after they are applied (at most 5 s), so a reload's first `get` is served from them. The page keys `[cacheId, page]` and `PersistStore.read(id, pages)` leave room for lazy loading. Rejected for now: lazy loading on first read (an asynchronous step inside `get`, which needs its own atomicity design); a byte budget for the eager part (needed with eviction). Measured: `getAll` of 16 pages, a year at one minute, 6.8 ms. Director, 2026-10-30

## Amendment, 2026-11-21

User decision 83, reading (i) (step 129): the "at most 5 s" above is the bound of the store's opening and its read, which the persister's timer measures (`timeoutMs`, architecture §4.10.6). What follows the read is outside it, as it always was: `restore`'s work on the stored points, one synchronous call in proportion to them, and, for a calendar cache in a zone, at most one budget of offset lookups (524,288, N113; about 1.5 s at the worst measured rate, and 38 lookups for a full daily page of bars). So `cache()` of a persisted cache answers within `timeoutMs`, plus the time of its points, plus at most one lookup budget. No mechanism changes. Loads are serialised, so a cache opened together with others also waits for the loads that run before its own.
