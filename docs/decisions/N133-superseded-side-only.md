# N133: Who is told of a deploy skew

Row N133 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 135 from the M5 design proposal (`docs/design/m5-deploy-skew.md`), which keeps the alternatives in full. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Only the tabs of the superseded worker.** The current generation's tabs have nothing to do. Rejected: both sides, with a `current` flag (an event the current side can only ignore). User decision 71, row F9 option (a), 2026-11-16 (§2.7, step 135)
