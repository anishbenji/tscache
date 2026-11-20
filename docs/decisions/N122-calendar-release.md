# N122: How the calendar grid ships (G17)

Row N122 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 129 from the calendar grid design proposal (`docs/design/calendar-grid.md`, row G17), which keeps the alternatives in full. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**In its own minor release, after M3 and before M5** (the order of decision 62), so each release carries one design and the calendar's compile-time breaks (N109, N114, N115) are named in its notes. Under 0.x a minor release may carry them (`packages/tscache/README.md`, "Stability"). Rejected: one minor release with M3, or with M5 (either delays one design by the other's build). User decision 83, row G17 option (a), 2026-11-21 (`docs/releases/0.3.0.md`, step 129)
