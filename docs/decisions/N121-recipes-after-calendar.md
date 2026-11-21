# N121: What happens to the fixed-grid recipes (G16)

Row N121 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 129 from the calendar grid design proposal (`docs/design/calendar-grid.md`, row G16), which keeps the alternatives in full. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**The daily-DST and monthly recipes are replaced by the calendar grid; the weekly (UTC) and jitter recipes stay; the ordinal technique stays as a note** for calendars the built-in units do not cover. One recommended way per case. The snippet regions and their `docs:run` checks follow. Rejected: keeping all four recipes (two ways to do one thing on one page); removing all but jitter (loses the UTC-weekly answer, which needs no calendar). User decision 83, row G16 option (b), 2026-11-21 (`site/concepts/grid.md`, step 129)
