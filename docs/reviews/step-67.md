# Step 67 — Demo insights and the benchmark page

Branch: `feat/67-demo-insights` · Status: built, awaiting the director's design review and the Codex round

The plan's section "### 67" in the pre-publish plan (2026-11-09) has two parts, both in demo, example and reference code only. Nothing under `packages/tscache/` changes, and the library's API is unchanged.

- **A. Cache or network, and time to chart, on every demo page.** Each page labels the read on screen "from cache N bars · from network M bars (K ms)" and times it "data → chart X ms (get Y + draw Z)", with the last value, the p50 and the p95 of the page's reads.
- **B. The benchmark page**, a new demo hub entry (`examples/benchmark`) that runs one workload in four modes (no cache, a per-tab memo, TanStack Query, tscache), with `scripts/demo-bench.ts` writing `docs/benchmarks/demo-comparison.md` and an end-to-end test that checks the counts.

## Scope

| Area                    | What                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `examples/mock-backend` | `src/insights.ts`: `withInsights` wraps the demo fetcher, and each fetch reports `{ cacheId, range, bars, bytes, pages, ms, startedAt, endedAt, ok }` on the BroadcastChannel `tscache-demo-insights`. `src/read-insights.ts`: the page side (instrumented handle, draw timing, labels). The fetcher counts body bytes; the backend counts points and bytes served. |
| Example apps            | vanilla-uplot (both pages), solid-uplot, solid-lwcharts, react-lwcharts, react-ssr, solid-ssr: each instruments its cache handle, reports each draw, and shows the panel.                                                                                                                                                                                           |
| Reference clients       | `reference/shared/src/session.ts` reads through instrumented handles and exposes `session.insights`; vanilla, React and Solid report draws and show the panel.                                                                                                                                                                                                      |
| `examples/benchmark`    | The benchmark page and its tab page; `@tanstack/query-core` 5.105.0, pinned, as a dev dependency of this workspace only.                                                                                                                                                                                                                                            |
| `scripts/demo-bench.ts` | Builds, serves and runs the page headless at 50, 300 and 1000 ms, and writes `docs/benchmarks/demo-comparison.md`.                                                                                                                                                                                                                                                  |
| Tests                   | `examples/mock-backend/test/insights.test.ts`, the backend's new counters, `examples/benchmark/test/`, `e2e/examples/benchmark.spec.ts`, and the insights labels on the events page (`e2e/examples/vanilla-uplot.spec.ts`).                                                                                                                                         |
| Hub                     | The benchmark is a catalog entry on its own origin (port 5107 in the suite); the launcher's spec and the docs count ten apps.                                                                                                                                                                                                                                       |

## Insights design (part A)

- **Instrumentation in the worker, by wrapping.** The fetcher runs in tscache's worker, out of the pages' reach. `withInsights(fetchSeries)` is the fetcher's default export: it times each fetch, counts the pages and body bytes the inner fetch reports through a `Meter`, and posts the report before the answer goes back to the cache. A failed fetch is reported with `ok: false` and its error rethrown unchanged.
- **A shared time line.** Reports carry `startedAt` and `endedAt` as `performance.timeOrigin + performance.now()`, which a worker and the pages of its origin share. A page's instrumented `get()` records when it was asked and answered on the same line.
- **Provenance.** A read's fetched bars are the bars of its answer inside the ranges of the fetches of its cache that ended while it was in flight and touched its range, whichever tab's read started them; the rest came from the cache. A fetch that started before the read began is a join, and the label says so. K is the longest of those fetches.
- **Late reports.** The report travels on its own channel, so it can arrive after the frame the answer was drawn in. The page then corrects the read on screen (`received` in `read-insights.ts`, tested). Times are never changed by a late report.
- **Time to chart.** From the instrumented `get()` until the frame after the chart library's `setData` returned: the page calls `insights.drawn(result)` right after `setData`, in the same task, and the draw is timed up to the next `requestAnimationFrame`. A result counts once (StrictMode's doubled effects, a redraw on resize).
- **Framework-native bindings.** The state is one immutable object replaced on each change. React reads it with `useSyncExternalStore` (with a server snapshot on the SSR pages), Solid with a signal (module-scope where the app keeps its other stores there, `onSettled` where hydration must match), the vanilla pages with `mountInsights`. The insights open their channel only on the first instrumented handle, so a server that renders a page opens none.

## Benchmark design (part B)

The comparison is only worth something if a skeptic cannot find a thumb on the scale. Each choice below says what it guards against and how to check it.

| Choice                                                                                                                                                                                                                                                            | Guards against                                         | How a skeptic checks it                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **One workload for every mode.** `workload.ts` computes every range from one anchor, which the page fixes once for all runs and modes: load, scroll back five screens, zoom out to four screens and in, return to the newest screen; then the same in three tabs. | A mode getting easier ranges.                          | `workload.ts` is pure; `examples/benchmark/test/workload.test.ts` pins the views. Each mode's tab runs the same `views` array the page sends it.        |
| **Same seeded data.** The anchor is yesterday at 12:00 UTC; every bar before it is final, a pure function of the series name and the timestamp (`examples/mock-backend/src/datasets.ts`).                                                                         | Data that differ by mode or change during a run.       | The backend's series are deterministic; the benchmark reads `crypto/BENCH` in every mode (tscache's cache ids add a segment that the fetcher ignores).  |
| **Same fetch and decode code.** No cache, memo and TanStack Query call the mock backend fetcher's `fetchSeries` in the page; tscache's worker loads the same module. All ask for columns bodies and page alike.                                                   | A baseline with a slower fetch path (JSON, no paging). | `modes.ts`: `fetchBars` calls `fetchSeries`; `examples/mock-backend/src/fetcher.ts` exports both.                                                       |
| **Same chart.** Every tab draws with the same uPlot setup and is timed the same way (`tab.ts`).                                                                                                                                                                   | A mode drawing less.                                   | One `readAll` loop in `tab.ts` for all modes.                                                                                                           |
| **TanStack Query configured fairly for immutable history.** One `QueryClient` per tab, key `[series, start, end]`, `staleTime: Infinity`, so a cached range is never refetched; default `gcTime` (5 min) outlasts a run.                                          | Handicapping the strongest baseline with refetches.    | `modes.ts`, `tanstack()`. The e2e test asserts TanStack Query makes exactly the memo's requests: the most an exact-key cache can save on this workload. |
| **The memo stores promises**, so a range asked again while in flight is not fetched twice (as TanStack Query dedupes).                                                                                                                                            | A strawman memo.                                       | `modes.ts`, `memo()`.                                                                                                                                   |
| **Fresh state per mode.** Each mode of each run opens new tabs (iframes) and a new tscache cache id; the backend's counters are read before phase one, between the phases and after, and reported as deltas.                                                      | One mode inheriting another's cache or counts.         | `runMode` in `bench.ts`; the per-run table in the results file shows every run.                                                                         |
| **Order rotation.** The modes take turns within each run, rotated by one each run.                                                                                                                                                                                | Warm-up or thermal drift favouring a position.         | `rotated` in `bench.ts`; the run table lists the order.                                                                                                 |
| **The first-load overhead is shown.** tscache's first connect (worker start and handshake) is a column of its own, and is inside the workload time and the first view's time to chart; tabs two and three connect inside the workload time too.                   | Hiding the worker hop.                                 | `setupMs` and `workloadMs` in `runMode`: the clock starts before the first tab opens.                                                                   |
| **Counts from the backend, not the client.** Requests are the series pages the backend answered; bars and bytes are what it served (new counters in `GET /api/stats`).                                                                                            | A client under-reporting its own fetches.              | `served()` in `bench.ts`; the counters in `backend.ts`, tested in `backend.test.ts`.                                                                    |
| **No cherry-picking.** Five runs per mode by default; medians are shown and every run is listed. A mode whose request count varied across runs is flagged in the table.                                                                                           | Reporting the best run.                                | `rows()` in `report.ts` (tested), the "Every run" table in the results file.                                                                            |
| **Latency selectable** (50, 300 or 1000 ms per backend page; 300 by default), and the results file has all three.                                                                                                                                                 | A latency chosen to flatter.                           | The three sections of `docs/benchmarks/demo-comparison.md`.                                                                                             |
| **Conditions printed with the table**: latency, runs, browser and version; the results file adds the commit and the date.                                                                                                                                         | Numbers out of context.                                | `describeConditions` in `report.ts`; the file's header.                                                                                                 |
| **The limits are named** on the page and in the results file: exact-key caches are per tab and not range-aware (the point of the comparison); the workload is final history only; the three tabs share one main thread; the backend is a local mock.              | Overclaiming.                                          | The page's "Limits of this comparison" and the results file's "Limits".                                                                                 |
| **One source of numbers.** `scripts/demo-bench.ts` writes `docs/benchmarks/demo-comparison.md`; nothing else quotes a number.                                                                                                                                     | Numbers drifting from the code.                        | Regenerate with `bun scripts/demo-bench.ts` (through the heavy-job lock) and diff.                                                                      |

### Why final history, and what that leaves out

The plan asks for "return to now". With the real now, the newest bar is still forming, and tscache refetches provisional bars on every read, while an exact-key cache serves its stored copy. Whether a minute boundary falls inside a run would then change tscache's count by one, so the counts would not be deterministic and the end-to-end test could not assert them. The workload therefore anchors in yesterday's final history and stands the live market in by moving the anchor on by five bars between the phases ("the market moves on"). This is named as a limit, and it is the conservative choice for tscache: a live workload adds tscache's provisional refetches and none of the baselines'.

### What the end-to-end test asserts

`e2e/examples/benchmark.spec.ts` runs the workload once per mode at 50 ms and checks only counts, which the workload fixes; it checks no timing (`docs/testing.md`):

- No cache makes one request per view per tab: 9 in one tab, 27 in three.
- The memo makes 7 in one tab (zooming back in and returning are repeats) and 21 in three; TanStack Query makes exactly the memo's.
- tscache ≤ memo ≤ TanStack Query ≤ no cache, in total requests.
- tscache in three tabs is one tab plus only the newest bars: exactly one request in phase two, of the five new bars plus at most a flank bar on either side, however the three tabs' reads met in the worker.
- tscache's phase one makes no more requests than the memo and transfers fewer bars (the zoomed-out view fetches only what the cache lacks).

## Decisions taken (open points, recommended option chosen)

1. **Final-history anchor with a five-bar shift**, not the live now (above). Recommended for deterministic counts; named as a limit.
2. **`@tanstack/query-core` 5.105.0**, the newest release at least 14 days old on 2026-11-09 (5.107.1 was three days old), as a dev dependency of `examples/benchmark` only.
3. **Phase two keeps tab one and opens two more**, and the three run at once, as a user with several tabs would.
4. **Counts from the backend** rather than from the insights channel, so every mode is measured by the same, client-independent meter.
5. **The benchmark lives in `examples/`** (`examples/benchmark`), so the examples Playwright project builds and serves it like the other apps and the demo hub picks it up from `e2e/examples/apps.ts`.

## Commits

| Commit  | What                                                                                                                     |
| ------- | ------------------------------------------------------------------------------------------------------------------------ |
| 3d811e4 | `feat(examples)`: the insights (fetcher wrapper, page tracker) and the panel on every demo page and reference client     |
| c1c5b62 | `fix(examples)`: a late fetch report corrects the read on screen; the Solid examples' wiring moves out of their sessions |
| 026bf8d | `feat(examples)`: the benchmark page, `scripts/demo-bench.ts`, the end-to-end spec and this file                         |
| 4de6610 | `docs(benchmarks)`: `docs/benchmarks/demo-comparison.md`, generated by the script                                        |
| ecbbe40 | `test(demo)`: the launcher's spec takes the app count from the app list (it counted nine by hand; there are now ten)     |

## CI

- `E2E_EXAMPLES=benchmark,vanilla-uplot bunx playwright test e2e/examples/benchmark.spec.ts e2e/examples/vanilla-uplot.spec.ts --project examples`, through the heavy-job lock: 5 passed.
- `bun scripts/demo-bench.ts`, through the lock: all three latencies done; the counts match the design (no cache 9 + 27, memo and TanStack Query 7 + 21, tscache 7 + 1) in every run.
- `bun run ci`, through the lock, at 4de6610: one failure, the launcher spec's hand count of nine apps (fixed in ecbbe40). At ecbbe40: exit 0 (Vitest 114 files, 2162 tests; Playwright 165 passed; Knip and Fallow clean).

## Not verified

- **First connect is small.** It measures `createClient()` and `cache()` in the first tab as the library resolves them; part of the worker's start may fall into the first read's time to chart instead, which the workload time includes either way. Not investigated further.
- **The baselines' p95 is about twice the backend latency**, the same for all three; tscache's p95 is about one latency. Seen in the generated file, not investigated (likely the three iframes' concurrent requests queueing on the one page and the preview server). It affects the baselines equally.
- **Long tasks** were zero in every run of headless Chromium; whether the observer in the page sees long tasks of its same-origin iframes was not checked separately.
- The insights panels of pages other than the events page were checked by type checks and the hub's launch tests (each page opens and draws), not by assertions on their labels.
- Firefox and Safari: not run.

## Contract-test changes

None. The new tests are demo tests; no contract test changed.

## Decision concerns

None.
