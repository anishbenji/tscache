# N116: How the page does grid arithmetic (G11)

Row N116 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 129 from the calendar grid design proposal (`docs/design/calendar-grid.md`, row G11), which keeps the alternatives in full. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**A new entry, `@anishbenji/tscache/grid`,** exporting `snapRange`, `slotStart` and `nextSlotStart` for fixed and calendar intervals, built from the same `grid.ts` the engine converts with. Only importers pay for it; the integrations use it to judge a `cacheChanged` range against a view (replacing their own fixed-step snap, which is wrong at every edge of a calendar view), and the reference client for its forming bar and its look one bar past an edge. Rejected: the same functions from the root entry (every application's `index` would grow); no export, with the integrations asking the worker (a round trip for each range check, inside the per-frame path of N84). User decision 83, row G11 option (a), 2026-11-21 (§2.10, step 129)
