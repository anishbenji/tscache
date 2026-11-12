# N15: How the slot cap is applied

Row N15 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Fixed pages**: a segment never crosses a multiple of `segmentSlotCap`. The layout then depends only on which points are present, so tests can state it exactly, equal data persists as equal payloads, and prepending history never reshuffles later segments. Cost: a short run that straddles a page edge is two segments. Rejected: fill a segment to the cap, then open the next (fewer segments in the straddling case, but the layout depends on arrival order). User-confirmed 2026-10-05
