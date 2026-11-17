# N94: Whether a pending orchestrated get's pages can be evicted

Row N94 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 121 from the M3 design proposal (`docs/design/m3-memory.md`). Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**A pending orchestrated `get` pins its request and one slot on each side** (the probe of its rounds) from its first round until its read has copied the result. Without the pin, a fetch landing for another tab between this get's fetch and its read could evict what the get had just fetched, and it would answer `uncached` for data it fetched; a consumer that re-gets its misses could then loop. Joined gets pin their own requests. A get that stops waiting because auth turned invalid releases its pin; its fetch's later put is then subject to the budget like any write. `cacheOnly` reads and reads without a fetcher pin nothing. The release ends in enforcement. Rejected: no pin. User decision 67, row E9 option (a), 2026-11-16 (§4.9, step 121)
