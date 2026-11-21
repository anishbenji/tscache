# N108: Where time-zone rules come from (G3)

Row N108 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 129 from the calendar grid design proposal (`docs/design/calendar-grid.md`, row G3), which keeps the alternatives in full. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**The runtime's `Intl`; nothing is bundled.** A zone's offset at an instant is read from `Intl.DateTimeFormat` (the `longOffset` time-zone name), so the bundle carries no zone data and the rules are as current as the runtime. The price is a slow lookup, which the tables of N124 absorb, and rules that can differ between two runtimes, which N113 checks. A grid in `"UTC"` asks `Intl` for nothing: its conversions are arithmetic. Rejected: UTC only (misses the headline case, a session open in a daylight-saving zone); a bundled subset of the IANA database (kilobytes comparable to the worker's whole budget, and a release process for data). User decision 83, row G3 option (a), 2026-11-21 (§4.1, step 129)
