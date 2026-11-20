# N90: What the budget counts

Row N90 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 121 from the M3 design proposal (`docs/design/m3-memory.md`). Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**The bytes the segments have allocated.** For each segment: its capacity times the bytes of one slot across its fields, plus its presence mask of `ceil(capacity / 8)` bytes. Spare capacity counts, so a sparse page pays the 64-slot minimum of each segment. Coverage ranges, merge warnings, read results and snapshots, put batches and other transient copies, a flush's or a load's records, and object overhead are not counted: the figure is a floor of the worker's memory, and a budget is a budget on cached points, not on the process. Rejected: the extents' bytes only (undercounts sparse and growing segments) and an estimate of object overhead (engine-specific guesses that drift). User decision 67, row E5 option (a), 2026-11-16 (§2.9, §4.3, step 121)
