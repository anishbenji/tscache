# N105: Whether pages that hold coverage and no point are bounded

Row N105 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 121 from the M3 design proposal (`docs/design/m3-memory.md`). Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Not now.** A page that holds coverage and no point (a confirmed gap) counts 0 bytes, never enters the use order and is never evicted; its small record (`segments: []`) is stored and loaded eagerly, as before (N46). The disk and load bounds of N95 hold in counted segment bytes only. The cost, documented: an empty authoritative put over N pages stores and reloads N small records. Rejected for now: counting each such page at a fixed cost or capping their number (new behaviour on coverage, and a cost per coverage change). The first test to write if this changes: an empty authoritative put over N pages under a budget, then a flush, asserting that the record count is bounded. User decision 67, row E22 option (a), 2026-11-16 (§2.9, step 121)
