# Step 118 — Design spec for a calendar grid (M4)

Branch: `docs/118-calendar-grid-spec` · Reviewer: not yet run (the director runs the review rounds) · Rounds: 0 · Status: awaiting review · Verdict after triage: —

## Scope

Drafts the calendar-grid design that user decision 32 A (2026-11-10) deferred until after 0.1.0, early, so that the user can answer its rows while M7 and M3 are built (decision 62, 2026-11-16: roadmap order M7, M3, calendar grid, M5). It answers finding M4 of the review of 2026-11-10 (`docs/reviews/2026-11-review.md`, M4 and §3b): the grid is fixed milliseconds (N9), so daily bars stamped at a session open in a daylight-saving zone are rejected as `'misaligned'` for half the year, and weekly and monthly bars rely on the step 71 recipes.

Documentation only: no code, no tests, nothing under `packages/` changes.

| Commit (by subject)                                     | What                                                                                                                                                                 |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs: propose the calendar-grid design for finding m4` | `docs/design/calendar-grid.md`; a "Design sketch: calendar grid" section in `docs/roadmap.md` linking to it; the `docs/design/` row of `docs/INDEX.md` and the sizes |
| `docs(review): step 118 scope and verification`         | This file; the `docs/design/` size in `docs/INDEX.md` after Biome's table formatting                                                                                 |

**Where the design lives.** A proposal file beside the M7, M3 and M5 proposals, with the same shape: the gap, what the engine has today (with file and line), the design with each recommendation taken, the decision rows, the contract tests and what changes when it is built. The architecture document records approved contracts, and this design would amend locked text (below), so the approved parts move into the architecture in the contract-test step.

**What it covers,** as the brief asked: today's grid (`grid.ts`, N9, `alignmentOffset`, the step 71 recipes in `site/concepts/grid.md:31-85` and `site/snippets/grid.ts`); the target cases (daily at a session open in a DST zone, trading-day calendars with holidays, weekly, monthly, 24/7, and two intraday cases the brief did not list but that bound the scope); the four options of the brief, each with its public API, its cost on every engine path that assumes fixed slots (snaps, coverage, segment caps, pages, gaps of K, persistence keys and records), its bundle size against the budgets and its behaviour when records written under one grid are read under another; the interactions with M3, M7 (including the integrations' `snappedOut` on `feat/114-m7-change-events`) and M5; migration; and twenty contract tests for the build step.

**Two findings the spec makes about the current engine.** (1) Everything inside the engine except `grid.ts` already runs on slot indices, and the payload decoder already reads a payload slot-relative (`segment/payload.ts:51-57`), so a calendar grid changes the two primitives of `grid.ts` and the places where the grid is _named_ (config, N20 comparison, payload, snapshot envelope, cache record, fetch request, the safe-integer domain checks), not coverage or segments. (2) A cache config crosses the port as a structured clone (`client/client.ts:208-215`), so a pluggable grid function cannot travel in the config; it would have to be code the worker loads, which today is only the fetcher module (N44). That is the main reason the proposal recommends data descriptors (option c) over functions (option b).

**Claims checked against the code.** Every statement about the current engine in the proposal's §2 tables and in §4–§6 cites a file and line on `main` at `362870f` (and `integrations/shared/changes.ts` on `feat/114-m7-change-events` at `7388283`); each was read at those lines, not inferred. The architecture sections cited (§2.2, §3.1, §3.4, §4.1, §4.10.2 at lines 1387-1395) and the decision files (02, 03, 04, N1, N9, N12, N13, N14, N15, N17, N20, N34, N39, N44, N55) were read in full. Bundle sizes come from `packages/tscache/bench/budgets.json`; the calendar code's own size (1–2 KB brotli) is labelled as an estimate in the proposal, to be measured by `scripts/size.ts` in the build step. The New York daylight-saving dates of 2026 (8 March, 1 November) used in the examples and tests were computed from the calendar, and match `site/snippets/grid.ts:40-42`.

## Decisions for the user

All seventeen rows, G1–G17, are open and listed with options, pros, cons and a recommendation in §8 of the proposal. None is decided here; the proposal's §5 assumes each recommendation. Rows that need the user's explicit approval because they amend locked or approved text, if taken as recommended:

- **G4 (a)** (`interval: number | CalendarInterval`) changes the meaning of decision 2's `interval` from always milliseconds to milliseconds or a calendar unit, keeping its words ("required, no default"), and narrows decision 3 (`alignmentOffset` must be absent or 0 with a calendar interval). N20's structural list is unchanged; `interval` is compared by value.
- **G9 (a)** (a `format: 2` snapshot, payload and cache record, written by calendar caches only) amends the locked payload invariant of architecture §3.4 (its field set and "t_i = start + i × interval"), N34 (the envelope's fields) and N53 (the record format). Fixed caches keep `format: 1` byte for byte.
- **G1 (c)** carries the above; **G1 (b)** would also add a second kind of application code in the worker (N44).

N9 needs no amendment with G13 (a) (the calendar code stays in `grid.ts`). G10 (a) is a compile-time break for TypeScript fetchers that read `request.interval` as a number, allowed in a 0.x minor release and named for the release notes. G14 (a) depends on M7's N79 (`hello.features`), which the order of decision 62 builds first.

## Verification

| Check                                                                                       | Result                                                                                        |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `bun run build`, then `bun run docs:check` (the site type-check needs the package's `dist`) | exit 0; "doc-anchors: 246 anchors in 42 pages resolve"                                        |
| `docs/INDEX.md` sizes, `wc -c` after the last edit                                          | `docs/design/` 324,696 bytes (324.7 KB, four files); `docs/roadmap.md` 14,283 bytes (14.3 KB) |
| `~/code/tscache-reports/bin/heavy-run.sh "118 child: ci" bun run ci`                        | Run on this commit, the branch's final head; the result is in the step report to the director |
| Code under `packages/`                                                                      | Unchanged (`git diff --stat main...HEAD` lists only `docs/`)                                  |

## Contract-test changes

None.

## Decision concerns

None.
