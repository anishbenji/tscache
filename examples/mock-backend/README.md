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

| Dataset | Fields | Behaviour |
|---|---|---|
| `candles` | `open`, `high`, `low`, `close` (f64), `volume` (u32) | Bars only in weekday sessions (13:30 to 20:00 UTC); daily bars on weekdays. The bar forming now is provisional |
| `metrics` | `cpu`, `p95` (f32), `requests` (u32) | A point in every slot. Request counts for the last 30 seconds are still arriving, so those points are provisional |
| `sensor` | `temperature`, `humidity` (f32), `battery` (u8) | Drops about 2 % of readings and goes offline for 15-minute blocks |
| `events` | `count` (u16) | Mostly empty slots, with bursts |

The field specs are exported (`@examples/mock-backend/datasets`), so an
example's cache config uses the same dtypes the backend serves.

## API

All routes live under `/api/`; the `mockBackend()` Vite plugin mounts them on
`vite` and `vite preview`.

- `GET /api/series/<dataset>/<symbol>?start&end&interval&offset` answers
  `{ timestamps, fields, meta: { version, finalizedUntil }, next? }` for the
  inclusive range, at most 5,000 slots per page and never past now. `next`
  is where the following page starts.
- `POST /api/auth/login` answers the current `{ access, refresh }` tokens
  (the demo has one user, already signed in).
- `POST /api/auth/refresh` with `{ refresh }` rotates both tokens; a refresh
  token works once.
- `POST /api/control` with any of `{ latencyMs, bumpVersion: true,
  expireAccess: true }` changes the latency (default 300 ms), restates every
  series under a new version, or replaces the access token.
- `GET /api/stats` counts series pages per dataset, refused requests,
  rotations and reused refresh tokens.

Series requests need a bearer token only when the plugin is created with
`mockBackend({ auth: true })`.

## Fetcher

`src/fetcher.ts` is a complete tscache fetcher (`docs/architecture.md` §2.5).
The cache id names the series as `<dataset>/<symbol>`, optionally followed
by more segments that keep ids apart (`candles/ACME/30m`). It loops over
pages until it holds the whole requested range, restarts if the dataset
version changes between two pages, reports the earliest watermark of all
pages, and throws `AuthInvalidError` on a 401. It announces each fetch on a
`BroadcastChannel` (`src/notices.ts`), which the examples use for their
fetch counters.

Each example loads the fetcher with `fetcherUrl()` from `tscache/vite`,
which makes `import url from "…?fetcher"` give the fetcher's URL with its
default export intact; Vite's `?worker&url` drops it.
`docs/guides/worker-setup.md` explains why.
