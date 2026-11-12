# N24: Browser coverage for the RPC layer

Row N24 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Node over `MessageChannel` at step ⑨; real Worker and ports with Playwright at steps ⑩ and ⑫.** No new dependency; Playwright is already present. Rejected: adding Vitest browser mode now (a second browser runner and a dependency decision for one test). User-confirmed 2026-10-07
