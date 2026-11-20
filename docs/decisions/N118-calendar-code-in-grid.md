# N118: Where the calendar code lives (G13)

Row N118 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 129 from the calendar grid design proposal (`docs/design/calendar-grid.md`, row G13), which keeps the alternatives in full. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**In `grid.ts`, beside the fixed-grid functions.** N9 then holds as written: `grid.ts` holds every ms↔slot conversion, the calendar arithmetic, the `Intl` lookup and the tables of slot starts included, and the fixed-grid functions keep their arithmetic. Rejected: a `calendar.ts` that only `grid.ts` imports (smaller files, but N9 would be reworded to "goes through `grid.ts`"). User decision 83, row G13 option (a), 2026-11-21 (§4.1, step 129)
