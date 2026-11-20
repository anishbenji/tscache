# N89: Whether there is a default memory budget

Row N89 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 121 from the M3 design proposal (`docs/design/m3-memory.md`). Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**No default.** Without `memoryBudget` nothing is evicted, nothing is counted, and 0.1.0's behaviour is unchanged. The memory guide recommends a budget for every application that lets a user browse many series. Rejected: a default such as 256 MB (it changes behaviour in a minor release, and any fixed number is wrong for someone). User decision 67, row E4 option (a), 2026-11-16 (§2.9, step 121)
