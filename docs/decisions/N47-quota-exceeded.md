# N47: Quota exceeded (P3)

Row N47 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Stop persisting that cache and emit the cache-scoped `persistStopped { cacheId, reason, error? }`**, `reason` one of `'quota-exceeded'`, `'unavailable'`, `'error'`; the cache goes on in memory and its records are deleted. The optional `error` (name and message) was added by the design, for diagnosis. Rejected: evicting the oldest pages (eviction is roadmap); failing the put (persistence must never fail a write). Director, 2026-10-30
