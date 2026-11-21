# N119: How a page learns that its worker lacks calendar grids (G14)

Row N119 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 129 from the calendar grid design proposal (`docs/design/calendar-grid.md`, row G14), which keeps the alternatives in full. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**`'calendar-grid'` in `hello.features` (N79).** A worker that supports calendar intervals lists it, and `client.cache()` refuses a calendar config itself, with a `ConfigError` that names the feature, before anything is posted, when the worker does not; `client.features` lets an application fall back to a recipe. `PROTOCOL_VERSION` stays 1 (N37): no op is added, and the `cache` op's parameters widen. Rejected: the old worker's own `ConfigError` ("interval must be a positive integer, got an object", for a config that is valid on the page's version). User decision 83, row G14 option (a), 2026-11-21 (§2.1, §3.1, step 129)
