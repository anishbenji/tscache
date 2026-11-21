# N111: The start of a slot whose local time does not exist or exists twice (G6)

Row N111 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 129 from the calendar grid design proposal (`docs/design/calendar-grid.md`, row G6), which keeps the alternatives in full. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**As `Temporal`'s `"compatible"`.** A local time that a transition skips starts after the shift (02:30 becomes 03:30), and one that occurs twice starts at the earlier instant. It is the rule of `Temporal` and RFC 5545, and it is total, so every slot has a start. One resolution takes at most three offset lookups: the offset a day before the local time gives a first instant; if the offset there is another, that one gives a second; if neither reads the local time, it does not exist and the first stands. A local date the zone skipped whole needs N123 as well. Rejected: refusing a config whose `at` can fall in a transition (a zone's transitions can only be checked year by year, and the rules change); the earlier instant in both cases (in a gap it reads before `at` on the wall clock). User decision 83, row G6 option (a), 2026-11-21 (§4.1, step 129)
