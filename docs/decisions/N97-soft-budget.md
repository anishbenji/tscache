# N97: Whether the budget may be exceeded

Row N97 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 121 from the M3 design proposal (`docs/design/m3-memory.md`). Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**A soft budget.** Pinned pages can hold the engine above its budget, a single read larger than the budget among them; `memoryStats()` reports the excess in `pinnedBytes`, and the enforcement at their release evicts it. No read or write ever fails for lack of room. Rejected: a hard budget (a new error on `put` and `get`, and a large read fails on a small budget). User decision 67, row E14 option (a), 2026-11-16 (§2.9, step 121)
