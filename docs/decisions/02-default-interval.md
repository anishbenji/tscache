# 2: Default interval

Row 2 of the decision table in `docs/architecture.md` §7 (the open decisions of starter §9, user-confirmed 2026-06-11). The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Required, no default** — deviates from starter proposal (60 000 ms): a silent default produces misalignment rejects far from the cause; one explicit line per cache is cheap

## Amendment, 2026-11-21

User decision 83, row G4 option (a) (N109, step 129): `interval` is required with no default, as before, and is now a fixed interval in milliseconds or a calendar interval (`interval: number | CalendarInterval`). The resolution's words stand; what `interval` means widened.
