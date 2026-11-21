# N112: How a zone is compared (G7)

Row N112 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 129 from the calendar grid design proposal (`docs/design/calendar-grid.md`, row G7), which keeps the alternatives in full. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**As written, after checking that the runtime resolves it.** Equality of two calendar intervals (N20, snapshots, records) never depends on the runtime, so one config cannot name two grids across a browser update or between a server and its page. The cost: two aliases of one zone (`US/Eastern`, `America/New_York`) are two grids; the documentation asks for canonical names. Rejected: canonicalising through `resolvedOptions().timeZone` (runtimes canonicalise some renamed zones differently). User decision 83, row G7 option (a), 2026-11-21 (§2.2, step 129)
