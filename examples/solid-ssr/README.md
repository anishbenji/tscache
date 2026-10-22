# Solid + server rendering

One sensor page rendered on the server, whose browser cache starts from what
the server read, empty slots included.

```sh
bun install
bun run build                               # builds the tscache package
bun run --cwd examples/solid-ssr dev        # http://localhost:5173/
```

The dev server renders the page and also serves the shared mock backend
(`examples/mock-backend`) under `/api/`, so nothing else needs to run.
`bun run --cwd examples/solid-ssr build` builds the browser bundle into
`dist/client` and the server entry into `dist/server`; `preview` serves the
built page, rendered on each request.

## Greenhouse sensor, rendered on the server

A greenhouse sensor, GH1, reports temperature, humidity and battery level
once a minute. It drops about 2 % of its readings and goes offline for
15-minute blocks, and the backend has no point for those minutes. Each
request for the page is rendered on the server from the last 24 hours: the
number of readings, how many minutes the cache knows are empty, the latest
reading, and how many of the readings this render took from the server's
own cache. With JavaScript turned off, that is the whole page. In the
browser the page hydrates, draws the day with uPlot, and keeps working from
its own cache: **Load the previous day** moves the start back 24 hours.

**Decision shown: the server reads through an in-process client.** The
server entry (`src/entry-server.tsx`) creates a client with
`mode: "in-process"`, which runs the cache and the fetcher module in the
server's own process (`docs/architecture.md` §2.1; the in-process engine
imports nothing from the DOM or the worker APIs at module top level). The
fetcher is the same module the browser's worker imports; on the server it is told the backend's
origin through its `context`, since a server-side fetch has no page origin
to resolve `/api/` against (`docs/guides/worker-setup.md`, "Server
rendering"). The render does all its async work first, two `get`s, and then
renders synchronously over plain props.

**Decision shown: coverage travels with the points.** The server writes its
answer into the page as seeds: each covered range of the `get` result with
the points inside it (`dehydrate` in `examples/mock-backend/src/hydration.ts`).
The browser puts each seed back with `put(batch, { range })`, so its cache
records the whole range as covered, not just the minutes that hold a reading
(§2.4, N3). The sensor's dropouts and offline blocks inside the range are
then confirmed gaps in the browser too: the "slots known to be empty" figure
keeps every one the server reported, and none of those minutes is fetched. The
browser's first `get` asks for the same window ending a moment later and
fetches only the minutes since the server's read; the log shows one fetch
of a minute or two. Seeding the points alone, without their range, would
claim only the span from the first reading to the last (the default put
range), and each dropout would look like time never fetched.

**Decision shown: one server client for every render.** The server creates
its client once, on the first render, and every later render reads from the
same cache. A render asks the cache for the day without fetching first
(`cacheOnly`), which gives the "readings from its cache" figure, and then
with fetching, which fetches only the minutes since the previous render.
Reload the page and the figure covers all but the newest minute. This suits
public data only: the sensor's readings are the same for every visitor, so
a cache shared across requests leaks nothing. Data that differs per user
needs a client per user, or no server cache at all. A shared cache also
keeps everything it was ever asked for, since tscache v1 has no eviction:
this page adds one reading a minute, but a server that reads many series
over long ranges should clear its caches on its own clock (`clear`,
`invalidate`, §2.4). If creating the client fails, the next render tries
again; in dev, the client is disposed before the dev server evaluates the
server entry again after a change.

**Decision shown: seeds never replace what the browser's cache covers.**
In the browser all tabs share one cache through the SharedWorker. A second
tab is rendered later than the first, but the first tab may have fetched
newer minutes since, and its cache may hold ranges the second tab's server
render never saw. `putSeeds` therefore asks the cache what it already covers
inside each seed's range (`cacheOnly`) and puts only the parts it does not
cover: a seed fills holes, it never overwrites. Open the page in two tabs
and the second tab's one fetch starts where the coverage of the first tab's
fetches ends.

## How hydration matches

The browser must render exactly what the server rendered before it takes
over. The page makes that structural:

- The server writes the props it rendered with into the page
  (`jsonScript("app-props", props)`), and `src/entry-client.tsx` hydrates
  `<App {...props} />` with those same values.
- `src/panel.tsx` renders the figures as a pure function of its props. Times
  are written in UTC and numbers without the locale, so the server and the
  browser produce the same text whatever their time zone and language.
- Everything live in the browser (the tscache client, the chart, the fetch
  count) belongs to `Live` in `src/App.tsx`, which `App` mounts only once
  hydration has ended (`onSettled` sets a signal, and `Show` switches from
  the server's panel to the live one). It creates its reactive nodes after
  hydration, so they cannot shift Solid's hydration ids, and it starts with
  the server's figures. The switch changes the status, the client's mode
  (from the server's `in-process` to `connecting`, then `shared`) and the
  button, which becomes enabled; the figures stay until the browser's first
  answer.

The data never goes through Solid's own serializer: the seeds are the
mechanism this page demonstrates, and they are plain tscache put payloads.

## What to watch

- The status goes from `server-rendered` to `hydrating` (connecting, putting
  the seeds, asking for the window) to `ready`. With JavaScript turned off
  it stays `server-rendered`, the client is `in-process`, and the button is
  disabled.
- After hydration the log shows one fetch: the minutes since the server's
  read, starting at the minute the seeds end. The day itself is never
  fetched by the browser.
- **Load the previous day** fetches one day, which ends exactly where the
  loaded range began (the miss is extended by one interval into the coverage
  it meets, §2.5), and the minutes since the last `get`.
- The "Server render" line says how much of each render came from the
  server's cache. The first render after the server starts fetches the
  whole day; every later one fetches a minute or two.

## Known limits

- A seed carries no dataset version. The server's `get` result does not
  report the version of the points it returns, so the browser puts the seeds
  without one (`meta.version`, §2.4). If the backend restated the series
  between the server's read and the browser's first fetch, the browser
  could not tell the seeded points are of the old version. A snapshot API
  that carries the version is a candidate for the post-build architecture
  review.
- Every `get` up to now fetches again. A `get` snaps its end outward to the
  minute after now, which the backend's watermark keeps provisional, so it
  stays outside coverage (§2.4); and its miss, which abuts the coverage, is
  extended one interval into it (§2.5), so the last covered minute is
  fetched again too.
- Solid is pinned to 2.0.0-rc.14, a release candidate, until 2.0 ships.

## What else is in here

- `src/session.ts` holds the browser's client and cache as async memos. The
  cache memo puts the seeds before it hands the cache out, so no `get` can
  run ahead of them. When the worker is lost, as when the tab hosting the
  SharedWorker crashes, the `workerLost` handler refreshes the client memo:
  the new client starts a new worker with an empty cache, the cache memo
  seeds it again from the page, and the new worker fetches only what the
  seeds do not cover.
- `src/App.tsx` derives the browser's answer as one async memo over the
  cache and the window's start, so loading the previous day is a write to
  the `start` signal, and a newer answer always supersedes an older one
  still in flight. The memo starts with a loading value, so the panel keeps
  the server's figures until the first answer lands.
- `src/chart.tsx` hands the `get` result's typed arrays to uPlot as they
  are: present points only, no copy and no slot grid padded with nulls. A
  gap refiner breaks the lines where readings are more than a minute apart,
  as uPlot does at a null. The chart is created once and updated with
  `setData`.
- `src/sensor.ts` holds the cache config and the figures, computed in one
  pass over the result's sorted coverage and timestamps.
