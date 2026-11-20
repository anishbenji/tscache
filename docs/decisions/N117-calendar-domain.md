# N117: The supported domain of a calendar grid (G12)

Row N117 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 129 from the calendar grid design proposal (`docs/design/calendar-grid.md`, row G12), which keeps the alternatives in full. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**The slots whose first local date lies in the years 1 to 9999.** The domain is within ISO 8601's four-digit years and far inside what `Intl` formats, and both of its ends follow from the descriptor by calendar arithmetic. It is checked once, inside the two primitives: `floorSlot` rejects an instant outside an arithmetic outer bound before any `Intl` call, and `startOf` rejects a slot more than two beyond either end, so no caller meets `Intl`'s own `RangeError`. A week that starts in 9999 and ends in the year 10000 is a slot of the domain. Rejected: the full `Date` range (edge behaviour of `Intl` at extreme years to verify in every supported runtime). The cost: narrower than a fixed grid's safe-integer domain. User decision 83, row G12 option (a), 2026-11-21 (§4.1, step 129)
