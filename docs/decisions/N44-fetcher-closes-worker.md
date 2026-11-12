# N44: A dedicated worker closed by its fetcher (DC-2 ii, step ⑫)

Row N44 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**A fetcher must not close its worker**; recorded in the fetcher contract (§2.5) and as an assumption in §4.8. Only the fetcher module runs app code inside the worker, so this is a programming error with an obvious cause. Rejected: a lifetime lock for dedicated workers too (extends N32 beyond its approved scope and holds one Web Lock per tab to catch a bug in the app's own module); request timeouts (rejected under N32: a guess at what counts as dead, and an orchestrated `get` can legitimately take long). User-confirmed 2026-10-23
