# Solid + Lightweight Charts

One page of candles with weekend gaps, built around coverage: what tscache
knows, kept apart from what exists.

```sh
bun install
bun run build                                 # builds the tscache package
bun run --cwd examples/solid-lwcharts dev     # http://localhost:5173/
```

The dev server also serves the shared mock backend
(`examples/mock-backend`) under `/api/`, so nothing else needs to run.

## Candles with weekend gaps

The page charts 30-minute OHLCV bars of a synthetic stock, ACME. Bars exist
only in weekday trading sessions, 13:30 to 20:00 UTC; nights and weekends
have none. The page opens on the last 14 days, asked of the cache with one
`get`. Drag the chart to the right to scroll back: when the left edge of the
view comes within ten bars of the first one, the page asks for the fortnight
before. **Load an earlier fortnight** does the same without dragging.

**Decision shown: coverage is separate from data.** The first fetch covers
all 672 half-hour slots of the fortnight. 130 of them hold a bar (ten
weekday sessions of 13 bars); the other 542 fall on nights and weekends,
and coverage records them as known all the same. The page counts them as
"empty slots known". The cache can tell a slot the backend confirmed empty
from one it never asked about, so it answers a weekend it holds from
memory. A cache that kept only the bars would find a hole of more than 65
hours every weekend and could not tell whether to fetch it. See `coverage`
in `GetResult`, `docs/architecture.md` §2.3.

**Decision shown: ask for everything, fetch only what is missing.**
Scrolling back does not ask for the older fortnight alone. It moves the
start of the loaded range back 14 days and calls `get` for the whole range
again, so the page's state is one number. The cache subtracts its coverage
from the request and fetches the rest: one request for the older fortnight,
which the log shows as 14 days, not 28. The miss is extended by one
interval on the side where it meets coverage (flank coalescing, §2.5), so
the fetch ends exactly where the loaded range began. The log also shows a
short fetch at the right edge on every `get`: the backend's watermark
(`meta.finalizedUntil`) keeps the current half-hour slot provisional, bar or
no bar, so it stays outside coverage and is fetched again each time (§2.4;
the vanilla example's dashboard is built around this).

**Decision shown: the chart hides the gaps; the cache knows them.**
Lightweight Charts places bars by index, not by time, so a weekend takes no
room on the time axis and the chart never shows a gap. Bars added on the
left shift the index of every bar in view, so the page shifts the visible
logical range by the number of bars prepended, and the view stays where it
was.

**Decision shown: `get` ranges are inclusive and snap outward.** The page
passes `Date.now()` and a start 14 days before it straight to `get`;
neither lies on the 30-minute grid. Both ends are inclusive, and `get`
snaps them outward to the grid (§2.3), so a chart's visible range, or any
range in milliseconds, can be passed without rounding.

## What else is in here

- `src/session.ts` keeps the client in an async memo. When the worker
  behind it is lost (`workerLost`), as when the tab hosting the SharedWorker
  crashes, the handler calls `refresh` on the memo: it connects a new
  client, which starts a new worker with an empty cache, and the cache
  handle and the chart's data, both derived from the client, follow. The
  new worker fetches the loaded range again in one request. See
  `docs/guides/worker-setup.md`.
- `src/main.tsx` derives the chart's data as an async memo,
  `cache().get({ start: start(), end: Date.now() })`, so scrolling back is a
  write to the `start` signal. While the older fortnight loads, `start()`
  keeps its committed value: the scroll events that keep arriving meanwhile
  ask for the same fortnight, and the backend sees one request. The status
  reads "loading" (`isPending`) while the chart keeps the bars it has.
- `src/chart.ts` sets up Lightweight Charts 5: a candlestick series, and a
  volume histogram on a price scale of its own along the bottom of the pane.
- The fetch count and the log come from the shared fetcher, which announces
  each fetch on a `BroadcastChannel`. Open the page in a second tab: both
  tabs share one SharedWorker and one cache, so the second tab fetches only
  the provisional slot at the right edge.
