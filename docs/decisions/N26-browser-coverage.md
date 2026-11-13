# N26: Browser coverage from step ⑩

Row N26 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Playwright in Chromium**, installed locally and in CI; the Node tests keep covering logic over `MessageChannel`. Rejected: staying Node-only until step ⑫ (real Worker/SharedWorker behaviour unverified for two more steps). User-confirmed 2026-10-08
