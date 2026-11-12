# N1: Range endpoint semantics

Row N1 of the decision table in `docs/architecture.md` §8 (N1–N8 user-confirmed 2026-06-11). The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Inclusive `[start, end]`** — matches charting-library visible ranges (Lightweight Charts `setVisibleRange`, uPlot `setScale` min/max; verified against current docs), so chart ranges feed `get` directly. Unaligned `get`/`invalidate` inputs **snap outward** to the grid (floor start, ceil end — invalidate over-invalidates conservatively). Internal range math runs on integer slot indices; the ms↔slot conversion is the one fencepost site. Rejected: half-open `[start, end)` (cleaner splicing, but every chart consumer would need ±interval shims)
