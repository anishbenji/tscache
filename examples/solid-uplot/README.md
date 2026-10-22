# Solid + uPlot

One page built around presence: which readings exist, and which ones the
cache knows to be missing.

```sh
bun install
bun run build                               # builds the tscache package
bun run --cwd examples/solid-uplot dev      # http://localhost:5173/
```

The dev server also serves the shared mock backend
(`examples/mock-backend`) under `/api/`, so nothing else needs to run.

## Greenhouse sensor

A greenhouse sensor reports temperature, humidity and battery level every
10 seconds. It drops single readings and goes offline for 15-minute blocks,
and the backend serves no point for those slots. The page opens on the last
6 hours, with buttons for the last hour and the last 24 hours; drag across a
chart to zoom in. The three charts share one time axis, and each line breaks
wherever a slot holds no reading.

**Decision shown: presence is one bit per point.** The cache stores a point
with all of its fields or not at all (`docs/architecture.md` §2.2). That is
why the three charts break at exactly the same places: a slot holds a
temperature, a humidity and a battery level, or none of them. Hover over a
gap and all three legends read "no reading".

**Decision shown: confirmed gaps are never fetched again.** A fetch is
authoritative for the whole range it asked for, so after the first fetch the
six hours are covered, empty slots included (`coverage`, §2.3). A break
inside covered time is a confirmed gap, drawn on a grey band; the
"confirmed gaps" count shows how many runs of empty slots the shown range
holds. A hatched band marks time that is not loaded, which happens only when
a fetch fails. The log shows the result. Zooming into any part of the six
hours asks the backend for nothing, and switching to the last hour asks only
for the seconds since the previous fetch. Without coverage, every dropout
would look like a range never fetched, and each view would ask for it again.

**Decision shown: an integer field cannot mark a missing value on its own.**
`NaN` is a legal value for a float field, so a backend could report a point
whose humidity reading failed by sending `NaN` for it. The battery level is a
`u8`, which has no such value: a point whose battery reading alone is missing
cannot be stored as such. This is a documented limitation (§2.2); the
payload format leaves room for per-field masks later. The sensor in this
demo sends all three readings or none.

**Switching to the last 24 hours** fetches only the 18 hours the cache does
not hold yet, plus the seconds since the previous fetch. Eighteen hours of
10-second slots exceed one backend page, so they arrive in two: the shared
fetcher loops until it holds the whole requested range, as a fetcher against
a paginated API must (§2.5). A cold load of 24 hours takes two pages as well.

## What else is in here

- `src/session.ts` holds the client and the cache as async memos. The cache
  memo reads the client memo, and the chart data reads the cache memo and the
  shown range. When the worker is lost, as when the tab hosting the
  SharedWorker crashes (`docs/guides/worker-setup.md`), the `workerLost`
  handler refreshes the client memo. The new client starts a new worker with
  an empty cache, and the cache memo and the chart data follow from it.
- `src/frame.ts` turns a `get` result into what uPlot draws: every slot of
  the shown range with `null` where the slot holds no point, plus the runs of
  confirmed gaps and of unloaded time. uPlot breaks a line at each `null`
  unless `spanGaps` is set.
- The fetch count and the log come from the shared fetcher, which announces
  each fetch on a `BroadcastChannel`. Open the page in a second tab: both
  tabs share one SharedWorker and one cache, so the second tab fetches only
  the seconds the first has not covered yet.
