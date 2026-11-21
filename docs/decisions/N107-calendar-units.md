# N107: Which calendar units exist (G2)

Row N107 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 129 from the calendar grid design proposal (`docs/design/calendar-grid.md`, row G2), which keeps the alternatives in full. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Day, week, month, quarter and year.** They are every OHLC timeframe above a day; a quarter and a year are a line each once months exist. A week names its first day (`weekStart`, 1 = Monday to 7 = Sunday, default 1). Slot 0 of each unit is the one that contains the local date 1970-01-01. Rejected: day, week and month only (quarterly and yearly bars would keep the ordinal recipe); sub-day units with a step (N120). User decision 83, row G2 option (a), 2026-11-21 (§2.2, step 129)
