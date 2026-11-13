# N17: `meta.finalizedUntil` direction

Row N17 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Forwards only**: a put's `meta.finalizedUntil` advances the watermark and a lower value is ignored, so fetch responses arriving out of order cannot pull it back and drop coverage. `setFinalizedUntil()` can still move it either way. Rejected: set exactly from `meta` (simpler rule, order-dependent result). User-confirmed 2026-10-06
