# N14: How the K gap is counted

Row N14 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**A segment splits where more than K consecutive slots hold no point.** With K = 4 at one minute, 10:00 and 10:05 (four absent) share a segment; 10:00 and 10:06 (five absent) do not. Rejected: split when the two points are more than K intervals apart (tolerates K − 1 absent slots; reads less naturally as "a gap of K"). User-confirmed 2026-10-05
