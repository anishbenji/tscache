# Mock backend

The synthetic time-series backend every example uses, with the fetcher
module the examples load into tscache's worker. It is a workspace package
that is never published.

## Data

Each series is a pure function of time: a point's values depend only on the
series, the dataset version and the timestamp, so every range the backend
serves agrees with every other, and history never changes until the
version does. That matches the use tscache is built for, data that is
final once published, while still exercising its other paths.

| Dataset   | Fields                                               | Behaviour                                                                                                         |
| --------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `candles` | `open`, `high`, `low`, `close` (f64), `volume` (u32) | Bars only in weekday sessions (13:30 to 20:00 UTC); daily bars on weekdays. The bar forming now is provisional    |
| `crypto`  | as `candles`                                         | Bars around the clock, every day; for the live feeds                                                              |
| `metrics` | `cpu`, `p95` (f32), `requests` (u32)                 | A point in every slot. Request counts for the last 30 seconds are still arriving, so those points are provisional |
| `sensor`  | `temperature`, `humidity` (f32), `battery` (u8)      | Drops about 2 % of readings and goes offline for 15-minute blocks                                                 |
| `events`  | `count` (u16)                                        | Mostly empty slots, with bursts                                                                                   |

The field specs are exported (`@examples/mock-backend/datasets`), so an
example's cache config uses the same dtypes the backend serves.

## API

All routes live under `/api/`; the `mockBackend()` Vite plugin mounts them on
`vite` and `vite preview`.

- `GET /api/series/<dataset>/<symbol>?start&end&interval&offset` answers
  `{ timestamps, fields, meta: { version, finalizedUntil }, next? }` for the
  inclusive range, at most 5,000 slots per page and never past now. `next`
  is where the following page starts. A request whose `Accept` names
  `application/vnd.tscache.columns`, with a quality above 0 and no lower
  than JSON's, gets the same page as a binary columns body instead (below);
  any other request, a wildcard alone included, gets JSON. Both answers
  carry `Vary: Accept`.
- `GET /api/stream/<dataset>/<symbol>?interval&offset` is a Server-Sent
  Events stream: a `bar` event every second carrying a put batch
  `{ timestamps, fields, meta }`, the bar forming now and, once a bar has
  closed, that bar with its final values. Unauthenticated, as `EventSource`
  sends no authorization header.
- A WebSocket on `/api/live` pushes the same batches. Its first message
  subscribes: `{ type: "subscribe", token, dataset, symbol, interval,
  offset? }`. A missing or stale token closes it with code 4401, a bad
  subscription with 4400; `dropStreams` closes it with 1012.
- `POST /api/auth/login` answers the current `{ access, refresh }` tokens
  (the demo has one user, already signed in).
- `POST /api/auth/refresh` with `{ refresh }` rotates both tokens; a refresh
  token works once.
- `POST /api/control` with any of `{ latencyMs, bumpVersion: true,
  expireAccess: true, failNext, dropStreams: true, advanceMs, resetClock:
  true }` changes the latency (default 300 ms), restates every series under
  a new version, replaces the access token, fails the next series requests,
  ends every live stream and socket, or moves the backend's clock on and
  back.
- `GET /api/stats` counts series pages per dataset and per format, the
  points and body bytes they carried, refused requests and subscriptions,
  rotations, reused refresh tokens and open live streams, and reports the
  backend's clock.

Series requests and socket subscriptions need a token only when the plugin
is created with `mockBackend({ auth: true })`. The socket upgrade is served
by `ws` on the dev and preview servers' HTTP server.

## Columns bodies

`src/columns.ts` defines a binary page format and its encoder and decoder,
for a fetcher that should not parse JSON. Every number is little-endian:

| Bytes              | Holds                                                                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4                  | the magic `TSC` and the format version, 1 (`54 53 43 01`)                                                                                          |
| 4                  | `H`, the header's length, as a u32                                                                                                                 |
| `H`                | the header, UTF-8 JSON: `{ count, fields: [{ name, dtype }], ...members }`, where the members are the JSON answer's other members (`meta`, `next`) |
| to a multiple of 8 | zero padding                                                                                                                                       |
| `count` × 8        | the timestamps, as f64                                                                                                                             |
| per field          | zero padding to a multiple of 8, then `count` values of the field's dtype                                                                          |

The body ends with the last column. Because every column starts on an
8-byte boundary, `decodeColumns` returns typed-array views over the one
`ArrayBuffer` that `response.arrayBuffer()` gives, with no copy. It throws
`ColumnsError` for a body that is truncated, longer than its columns, or
not this format. `fromColumns` and `fromJson` normalize each page of a
range, and `joinPages` joins them by one rule table (in the code and the
guide): one dtype stays that dtype, JSON stays numbers, and any mix of
formats or dtypes widens to float64, never narrows; pages whose field
names differ are refused. `isColumnsType` and `acceptsColumns` compare
media types without their parameters or case. Integer columns cannot
carry `NaN`, so `encodeColumns` refuses a value its dtype cannot hold. The fetcher guide on the site
explains the format and when to use it.

## Fetcher

`src/fetcher.ts` is a complete tscache fetcher (`docs/architecture.md` §2.5).
The cache id names the series as `<dataset>/<symbol>`, optionally followed
by more segments that keep ids apart (`candles/ACME/30m`). It loops over
pages until it holds the whole requested range, restarts if the dataset
version changes between two pages, reports the earliest watermark of all
pages, and throws `AuthInvalidError` on a 401. It asks for columns bodies
and reads JSON when the backend answers JSON; a context with
`format: "json"` makes it ask for JSON. It announces each fetch on a
`BroadcastChannel` (`src/notices.ts`), which the examples use for their
fetch counters.

The default export is the fetch wrapped by `withInsights` (`src/insights.ts`):
each fetch is timed, its pages' body bytes are counted, and a report
(`{ cacheId, range, bars, bytes, pages, ms, startedAt, endedAt, ok }`) goes
out on the `BroadcastChannel` `tscache-demo-insights` before the answer
returns to the cache. The benchmark page's modes without tscache call this
default export in the page, as tscache's worker does; the unwrapped fetch,
exported as `fetchSeries`, serves only the page's preview chart.

## Insights

`src/read-insights.ts` is what every demo page shows about its reads. A page
wraps its cache handle with `insights.instrument(handle)`, which times each
`get()`, and calls `insights.drawn(result)` right after the chart library's
`setData` returned. The panel then says how many of the drawn bars came from
the cache and how many from the network ("from cache N bars · from network M
bars (K ms)"), and the read's time to chart ("data → chart X ms (get Y + draw
Z)"), with the last value, the p50 and the p95 of the page's reads. A read's
fetched bars are those in its range that a fetch brought while it was in
flight, from any tab of the origin; a read that joined a fetch already in
flight says so. The state is one immutable object replaced on each change, so
each framework binds it as it binds any store. It is demo instrumentation:
the library has no such API.

Each example loads the fetcher with `fetcherUrl()` from `@anishbenji/tscache/vite`,
which makes `import url from "…?fetcher"` give the fetcher's URL with its
default export intact; Vite's `?worker&url` drops it.
`docs/guides/worker-setup.md` explains why. Each example and reference
client also sets `worker: { format: "es" }`, so the worker's persistence
code is a chunk of its own rather than inlined into the worker file.
