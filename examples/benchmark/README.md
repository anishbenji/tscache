# Benchmark: tscache and three baselines

The demo hub's benchmark page. It runs one seeded workload in four modes and
shows what each cost the backend and the chart.

```sh
bun install
bun run build                               # builds the tscache package
bun run --cwd examples/benchmark dev        # http://localhost:5173/
```

The dev server serves the shared mock backend (`examples/mock-backend`) under
`/api/`. `bun run demo` lists the page in the hub.

## The workload

A chart of one-minute candles opens on the newest screen (240 bars), scrolls
back five screens, zooms out to four screens and back in, and returns to the
newest screen. Then the market moves on by five bars and three tabs do the
same at once: the first tab again and two new ones. The tabs are same-origin
iframes (`tab.html`), so tscache's tabs share one SharedWorker, as real tabs
of one origin do. `src/workload.ts` computes every range from one anchor in
yesterday's final history, so every mode reads the same bars.

## The modes

| Mode                                       | Between the chart and the fetcher                                                                  |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| No cache                                   | Nothing: every view fetches its range                                                              |
| Per-tab memo (exact range)                 | A `Map` per tab, keyed by the exact range, holding each fetch's promise                            |
| TanStack Query (exact-range keys, per tab) | `@tanstack/query-core`: one QueryClient per tab, key `[series, start, end]`, `staleTime: Infinity` |
| tscache                                    | A client per tab, all on one shared cache, which fetches only what it does not hold                |

Every mode fetches with the mock backend's fetcher, the module tscache's
worker loads, and draws with the same uPlot chart (`src/modes.ts`,
`src/tab.ts`). TanStack Query here is keyed by exact range, in memory, per
tab; a configuration with aligned chunks and a cache persisted across tabs is
not measured. Each mode of each run starts
empty, and the backend's counters are read as deltas. The page's "Limits of
this comparison" names what the comparison does not show.

## Results

Pick a backend latency (50, 300 or 1000 ms per page) and a run count, and run.
The table shows medians over the runs, with the conditions above it, and
**Copy as Markdown** copies it. The numbers the documentation quotes come only
from `docs/benchmarks/demo-comparison.md`, which `bun scripts/demo-bench.ts`
generates by running this page headless at all three latencies. Its design
and fairness rules are in `docs/reviews/step-67.md`.

For automation, the page reads `?latency=`, `?runs=`, `?modes=` (a comma
list) and `?autorun=1`, and writes its results as JSON into
`[data-testid="results-json"]`. `e2e/examples/benchmark.spec.ts` runs the
workload once per mode and checks the request counts; it checks no timing.
