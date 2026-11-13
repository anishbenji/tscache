# N63: Subtraction and the flank rule

Row N63 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Subtract before coalescing; extend into coverage only** (§4.9.1 rule 3). The locked flank and bridge extension applies to covered slots, a covered slot inside a fetch in flight included. A piece abutting an in-flight range meets it edge to edge, and the coverage index merges the two when both have landed. Pieces separated by in-flight slots are separate requests. Rejected: extending into in-flight ranges (one slot fetched twice at every boundary, and in-flight slots are not coverage); coalescing first and subtracting after (a remainder could lose its locked flank); fetching through a short in-flight stretch to save a request (a double fetch, and a threshold to defend). Director, 2026-10-30
