# Step 129 — the calendar grid

Branch: `feat/129-calendar-grid` · Reviewers: none yet (the director runs the pre-review, the security lane and the Codex gate after the implementer's report) · Status: built, awaiting review · The user merges: the step touches the public API, the architecture and locked decisions

## Scope

Builds finding M4 of the review of 2026-11-10, as designed in `docs/design/calendar-grid.md` (step 118) and decided by the user on 2026-11-21 (decision 83): a cache's `interval` may be a calendar interval, one slot per day, week, month, quarter or year in an IANA time zone, starting at a local time.

- **Phase A (Codex, contract tests).** `calendar-grid.test.ts`, `calendar-grid-cost.test.ts`, `calendar-engine.test.ts` and `calendar-records.test.ts` with `calendar-contract-helpers.ts`: the design's §9 tests 1–17 and the fourteen cases of §9.1, each through `hydrate` and through a load. 179 failed for missing behaviour before phase B; all pass now.
- **Architecture.** The approved text moved into `docs/architecture.md`: §2.1 (the feature name), §2.2 (the calendar interval and its rules), §2.5 (the fetch request), §2.8 (format 2, and what a reader checks when zone data differs), a new §2.10 (the grid entry), §3.1, §3.4 (the format 2 payload), §4.1 (the grid contract: the two primitives, the resolution of a local time, the domain, the tables and the fill rule, the test seam), §4.2 (decoding), §4.5 (hydrate's validation, with the lookup charge and the stored slot indices; the code sketches brought in line with the code), §4.10.1, §4.10.2 (the format 2 cache record), §4.10.5 (the load's budget, and a stored watermark outside the domain) and §4.10.6 (what the open's timer bounds). Decisions N106–N124 have a file each and a line in §8; decisions 2 and 3 and N34, N35, N38, N46, N53 and N57 carry dated amendments. The proposal is marked decided and specified.
- **Engine.** `grid.ts` holds the calendar beside the fixed grid (N118). A `Grid` is a fixed grid or a calendar grid; `CacheState` holds its grid, and every conversion takes it instead of the config. The calendar's parts: slot numbering by arithmetic, the resolution of a local time through the zone's offset in at most three lookups (N111), the start of a slot whose date the zone skipped (N123), the domain checked inside `floorSlot` and `startOf` (N117), and tables of 512 slot starts per descriptor in one least-recently-used order per engine, filled only for a conversion that needs more than half of a block (N124). Zone offsets come from `Intl.DateTimeFormat`'s `longOffset` name (N108).
- **Config.** `interval: number | CalendarInterval`, validated with a `ConfigError` per field and compared by value under N20 (N109, N112).
- **Formats.** A calendar cache writes `format: 2` payloads, snapshots and cache records (N114) with the slot index of each anchor (N113). `hydrate` and a load refuse a record whose anchors this engine's zone data places in other slots, after comparing the record's charge with a budget of 524,288 offset lookups. `encodeSnapshot` and `decodeSnapshot` carry both formats. A fixed cache's bytes are unchanged (test 1 pins the 0.1.0 fixture).
- **Orchestrator and RPC.** The fetch request carries the resolved interval (N115); the orchestrator and the server take the cache's grid through `cacheGridOf`; the worker lists `'calendar-grid'` in `hello.features`, and `client.cache()` refuses a calendar config against a worker that does not (N119).
- **Entry.** `@anishbenji/tscache/grid`: `snapRange`, `slotStart`, `nextSlotStart` (N116). The integrations' `reaction` and `keepFailures` use it in place of their fixed-step arithmetic; the reference client uses it for its forming bar and its look one bar past an edge.
- **Bench and size.** Eleven calendar cases; budgets raised for the three entries that grew past theirs, and a budget for the new entry (below).
- **Docs.** The grid page, the fetcher, server-rendering and persistence guides, troubleshooting, the entry and config tables, and the 0.3.0 release notes.

## Decisions applied

- **User decision 83 (2026-11-21):** every recommended option of rows G1–G19, recorded as N106–N124; G8 is (c), so G20 was not asked and nothing of the design's "If G8 (d) is taken" part is built; reading (i) of N46.
- **The lookup budget** is the sketch's 524,288, unchanged. The build showed no reason to change it: the largest record within it (14,562 coverage ranges of one slot) hydrates in the time the bench reports below.
- **Director's answers to the contract-test step's ambiguities:**
  - **B1, seams.** `EngineOptions` gains nothing. An engine takes its context through `useCalendarGridContext(engine, context)` (`engine/engine.ts`), which no entry exports, as M3's `engineMemoryInternals` is. Of the five `grid.ts` exports the tests asked for, none is reachable from a public entry as such: `createCalendarGridContext`, `createCalendarGrid` and `resolveCalendarStart` are imported by tests only (and `createCalendarGrid` by `gridOf`); `startOf` and `floorSlot` are imported by `entries/grid.ts`, which wraps them as `slotStart` and `nextSlotStart` and does not re-export them. No proposal to make any of them public.
  - **B2, the budget fencepost.** "At most 524,288 lookups": a charge of 524,280 is within it and 524,292 over, as the tests have it.
  - **B3.** Case j's crafted page is accepted as input validation.
  - **B4, a malformed stored watermark.** For a calendar cache, a stored `finalizedUntil` that is a number outside the calendar's domain is set aside: the cache record is otherwise accepted, the valid pages are applied, and the records are rewritten at the next flush. See "Decision concerns".
  - **B5.** `cache.config.grid` is the format 2 record field; architecture §4.10.2 documents the record type.

## Implementer's choices

Choices the approved text left open, or where the build differs from a sentence of the proposal. Each is small; they are listed so that a reviewer or the user can reverse one.

1. **The budget binds grids that look offsets up.** The charge is compared with the budget for a calendar grid in a zone other than `"UTC"` only (`lookupBudgetOf`). A `"UTC"` calendar makes no lookup, so a budget would refuse its fragmented records for no cost avoided. The proposal states the check for format 2 without that distinction.
2. **A snapshot's writer can spend 36 lookups on the range, not 24.** `snapshot(range)` snaps the range (two conversions, at most 24) and converts the snapped slots back (at most 12). The proposal's sentence for the writer says 24 for the range. The writer's total stays within the record's charge whenever the snapshot has a coverage range or two payloads, since a coverage range costs the writer 12 of its 36 and a payload 6 of its 12; an empty snapshot whose two range ends each need the worst case could reach 36 against a charge of 24. Writers have no budget, so nothing is refused; the contract tests' bounds for the writer hold in every case they run. Architecture §2.8 states the writer's cost as built.
3. **Each anchor is converted once.** `slotRange` and the payload decoder call `slotOf` once per instant and keep the slot, where the earlier code called `isAligned` and then `slotOf`; a range whose two ends are one instant converts it once. The checks and their messages are the same.
4. **A put's timestamps are converted in one call that decides the grid kind once** (`slotsOf`), and the order check runs after it, up to the first misaligned timestamp. The rejections are the same as before, in the same precedence (at one index, misalignment before order); `batch-rejections.test.ts` and the batch tests pass unchanged. A read converts its slots with `msInto` the same way. Single conversions (`isAligned`, `slotOf`, `msOf`, the snaps) test the grid kind on each call, one property read.
5. **`Snapshot.segments` is `DenseSegmentPayload[]` in both formats.** The proposal says the four public types become unions; it does not say whether a format 1 envelope's `segments` is typed as format 1 payloads only. The looser type keeps code that builds or maps a snapshot's segments compiling; `hydrate` refuses a payload of the other format at run time.
6. **New public type names:** `CalendarInterval`, `ResolvedCalendarInterval`, and the union members `FixedSnapshot`, `CalendarSnapshot`, `FixedSegmentPayload`, `CalendarSegmentPayload`, exported from the root and `./engine` (the first two also from `./fetcher` and `./grid`).
7. **Offsets are read from `timeZoneName: "longOffset"`,** not from formatted date fields: it gives the offset to the second (historical local mean time included) and does not depend on the calendar `Intl` formats old dates in. A runtime without `longOffset` (before Chrome 95, Firefox 91, Safari 15.4, Node 18) rejects a zone other than `"UTC"` with `ConfigError`; the grid page says so.
8. **Messages.** A fixed cache given a format 2 snapshot or payload (and the reverse) fails with "format 2 names another kind of grid than the cache's" in place of "unsupported format 2"; an unknown format keeps "unsupported format". `decodeSnapshot` says "format must be 1 or 2".
9. **Size.** The engine grew by 3.2 kB brotli, above the proposal's estimate of 1–2 kB for the approach (G1); N106 states the measured figure.
10. **Not built: the reference client's chart arithmetic.** `reference/shared/src/market.ts` and `session.ts` use the grid entry (the forming bar; one bar past an edge). `chart/view.ts` (`moved`, half an interval) and `chart/lightweight.ts` (extrapolating times past the loaded bars by whole intervals) still take a number: the reference clients chart one fixed one-minute market, and a calendar market there is a feature of its own. The proposal's §10 lists both files.
11. **Not built: bench cases for a load.** The bench drives the public `./engine` entry, which has no load (the persister is internal), so the load of a full daily page, of the largest record, and with the store's read held just under `timeoutMs` are not timed. A load validates a page with the code `hydrate` validates a snapshot with, which the two `calendar-hydrate-*` cases time; the contract tests pin a load's lookup counts and the budget's cut (test 17), under fake time.
12. **Two Fallow suppressions** (`// fallow-ignore-file duplicate-export`) in `calendar-contract-helpers.ts` and `m7-change-test-helpers.ts`: the test helpers each export a `batch` and a `config` of their own, and Fallow audits the pairs among the files a branch changes.

## Contract-test changes

No assertion was weakened, removed or skipped. The edits are wiring and types.

**Phase A files (Codex, this step):**

- `calendar-contract-helpers.ts`: `engine()` hands the context to the engine with `useCalendarGridContext(e, context)` where it passed `new Engine({ calendarGrid: context })` (B1). Its own `CalendarPayload` and `CalendarSnapshot` interfaces are gone: `format2` returns the package's `CalendarSnapshot`, so the tests check the public type (the helper's export had the same name as the public one, which Fallow reports). `makeContext` is no longer exported (nothing imports it). One Fallow suppression line (choice 12).
- `calendar-grid-cost.test.ts`, `calendar-records.test.ts`: import the `CalendarSnapshot` type from `../src/types`.

**Earlier contract tests, for the widened types:**

- `cache-hydrate-rejections.test.ts`: the segment options take `c.grid` where they took `c.config`.
- `engine-snapshot.test.ts`: `{ ...snapshotFixture(), interval: 11 }` is cast to `Snapshot` (a spread of the union with `interval` is an excess property for the calendar member).
- `m3-memory-events.test.ts`, `m7-change-test-helpers.ts`: `toMs` takes `cacheGridOf(engine, id)` where it took `engine.configOf(id)`.
- `merge-property.test.ts`: `msOf(slot, gridOf(config))`.
- `persist-store-conformance.test.ts`: the mutation of a stored config's `interval` goes through a cast to the fixed record's shape.
- `persist-test-helpers.ts`: the `recordsOf` oracle narrows `interval` to a number (it does a fixed grid's arithmetic).
- `m7-change-rpc.test.ts`, `rpc.test.ts`: the pinned feature list gains `'calendar-grid'`.

**A test that looked wrong against the spec:** none found.

## Other changes outside the package

- `e2e/examples/support.ts`: `coveredPoints` narrows a payload to format 1.
- `integrations/shared/changes.ts`: `Grid.interval`, `keepFailures`, `cacheOnlyAfter` and `ViewReadsOptions.interval` take a number or a calendar interval; `reaction` snaps with `snapRange`.
- `vitest.config.ts`: an alias for `@anishbenji/tscache/grid`, as for the other entries the workspace tests import by name.
- `scripts/size.ts`, `site/typedoc.json`, `packages/tscache/tsdown.config.ts`, `packages/tscache/package.json`: the new entry.

## New tests (implementer, with the code)

- `packages/tscache/test/calendar-surface.test.ts` — **18:** `snapRange`, `slotStart` and `nextSlotStart` equal the engine's `toMs(snapOut())` and its two primitives for seeded ranges, on six calendar grids in five zones (300 ranges each) and on fixed grids (2,000 ranges), and reject what a config or a read rejects. **19:** this package's worker lists `'calendar-grid'` and takes a calendar config; against a hello without the feature, or with other features only, `cache()` rejects with `ConfigError` naming the feature, and the worker's only request is the fixed config sent after it (an ordered answer on the same port, no pause).
- `integrations/test/changes.test.ts` — **20:** `reaction` on a New York daily grid across the start of daylight saving: a write or a removal at either calendar edge of an unaligned view wakes it, one a slot outside does not; a fixed 24-hour step misplaces the same edge.
- `e2e/calendar.spec.ts` — **21:** two pages of one context share a New York daily cache through the SharedWorker; a put in one is read in the other at the session opens of both seasons. **22:** a snapshot taken by an engine in the Node test process, carried as the JSON text of `encodeSnapshot`, is decoded and hydrated in the page and applies in full; and a persisted calendar cache is read after a reload (a second worker URL) with no request to the backend.

## Decision concerns

1. **B4: a stored watermark outside a calendar's domain.** The proposal's §5.2 says a load sets such a watermark aside; architecture §4.10.5 step 2 refused the whole cache record, and so its pages, when the watermark failed validation. Built as the director ruled, for calendar caches only: the watermark is set aside, the otherwise valid pages are applied, and the records are rewritten at the next flush. A fixed cache still refuses the record. This loses the least data. What it gives up: a record whose watermark is damaged may hold damaged pages too. Each page is still validated on its own, as every page is, and with no watermark every valid page's coverage is applied as final; a writer never covers a slot it holds as provisional, so no provisional point is among them. **For the user to confirm or reverse.** Reversing it is one branch in `storedMeta` (`engine/restore.ts`) and one sentence of §4.10.5.
2. **Choice 1 above (no budget for a `"UTC"` calendar)** is the implementer's reading, not the proposal's words. It refuses fewer records and bounds the same work. Listed here because it concerns an approved rule.

## Verification

Filled in at the final head; see the implementer's report for the commands and their results.

## Sizes

Brotli, bytes as `scripts/size.ts` reports them in kB; before is `main` at `6716b4d5`, after is this branch.

| Entry                  | Before   | After    | Budget before | Budget after |
| ---------------------- | -------- | -------- | ------------- | ------------ |
| `index`                | 5.31 kB  | 5.63 kB  | 5,952 B       | unchanged    |
| `index` (lazy)         | 14.25 kB | 17.29 kB | 15,104 B      | 18,240 B     |
| `index` (lazy, nested) | 5.39 kB  | 5.61 kB  | 6,000 B       | unchanged    |
| `worker`               | 15.50 kB | 18.48 kB | 16,352 B      | 19,488 B     |
| `worker` (lazy)        | 5.39 kB  | 5.61 kB  | 5,824 B       | unchanged    |
| `engine`               | 11.57 kB | 14.75 kB | 12,352 B      | 15,616 B     |
| `fetcher`              | 0.17 kB  | 0.17 kB  | 656 B         | unchanged    |
| `grid`                 | —        | 3.14 kB  | —             | 3,728 B      |
| `vite`                 | 1.24 kB  | 1.24 kB  | 1,488 B       | unchanged    |

A raised budget is the measured size plus max(512 B, 3 %), the repository's rule; an entry still inside its budget keeps it.

## Bench

Filled in from the final run; see the implementer's report.
