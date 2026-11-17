# N100: Whether `./engine` takes a budget too

Row N100 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 121 from the M3 design proposal (`docs/design/m3-memory.md`). Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Yes: `new Engine({ memoryBudget })` and `engine.memoryStats()`.** A server render's process-wide engine is the longest-lived cache there is. The constructor throws `ConfigError` for a value that is not a positive safe integer. Rejected: clients only (server users would stay unbounded). User decision 67, row E17 option (a), 2026-11-16 (§2.9, §4.6, step 121)
