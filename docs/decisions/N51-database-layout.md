# N51: Database layout (P7)

Row N51 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**One database `tscache` at IndexedDB version 1, stores `caches` (key `cacheId`) and `pages` (key `[cacheId, page]`)**, so one transaction writes a cache record and its pages together. Rejected: a database per cache (no transaction across them, a connection each). Director, 2026-10-30
