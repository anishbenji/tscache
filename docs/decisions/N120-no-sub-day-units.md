# N120: Whether sub-day units in a zone are supported (G15)

Row N120 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 129 from the calendar grid design proposal (`docs/design/calendar-grid.md`, row G15), which keeps the alternatives in full. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Not now.** Fixed grids cover intervals that divide an hour, and the documentation says so; the first build keeps to units of a day or more, where a slot's local date is its identity. Bars at intervals that do not divide an hour, anchored to a local time in a daylight-saving zone, stay unsupported. Rejected for now: `unit: "hour"` and `unit: "minute"` with a `step` (sub-day slots meet transitions inside a day: a repeated hour holds two slots with one local label and a skipped hour none, so N111's rule is no longer enough). Revisit on a user's need. User decision 83, row G15 option (a), 2026-11-21 (§2.2, step 129)
