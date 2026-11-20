# N115: How the fetch request names the grid (G10)

Row N115 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 129 from the calendar grid design proposal (`docs/design/calendar-grid.md`, row G10), which keeps the alternatives in full. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**As the config does: `FetchRequest.interval` is `number | ResolvedCalendarInterval`,** with `alignmentOffset` 0 for a calendar interval. The range is in milliseconds, aligned to slot starts and coalesced as before: a miss that abuts covered slots is extended one slot into them (a month on a monthly cache), and a flank with no coverage next to it is not. A TypeScript fetcher that does arithmetic on `interval` is told at compile time; one that only stringifies it is not (`String(request.interval)` compiles and sends `[object Object]` for a calendar cache), which the release notes name. Rejected: `interval` staying a number (0 for a calendar) beside a `calendar` field (a fixed-grid fetcher reused for a calendar cache would compute with 0 silently); a discriminated union on a `kind` field (also a compile-time break, and a new field to carry). User decision 83, row G10 option (a), 2026-11-21 (§2.5, step 129)
