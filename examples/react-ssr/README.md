# React SSR

A server-rendered React 19 page of daily candles. The server reads the last
half-year through tscache and renders the page from it; the browser's cache
starts from what the server read, so on load the browser fetches none of
the history the server already fetched.

```sh
bun install
bun run build                             # builds the tscache package
bun run --cwd examples/react-ssr dev      # http://localhost:5173/
```

The dev server renders the page on every request and serves the shared mock
backend (`examples/mock-backend`) under `/api/`, so nothing else needs to
run. `bun run --cwd examples/react-ssr build` builds the browser bundle into
`dist/client` and the server entry into `dist/server`; `preview` then serves
the built page the same way.

## The server reads, the browser carries on

The page charts daily bars of a synthetic stock, ACME, for the 182 days up
to now. Bars exist on weekdays only. The backend's watermark
(`meta.finalizedUntil`) keeps the current day provisional: its bar is still
forming.

On every request the server entry (`src/entry-server.tsx`) asks its cache
for the window and renders the page from the answer with `renderToString`:
the figures, a table of the last five sessions and an empty container for
the chart. The page works without JavaScript; the chart is the only part
drawn in the browser. Into the page's head go two JSON script elements: the
props the page was rendered with, and the seeds, the covered parts of the
answer, each with the points inside it (`dehydrate` in
`examples/mock-backend/src/hydration.ts`).

**Decision shown: the server reads through the same API as the browser.**
The in-process engine needs no worker and no DOM (§2.1), so the server
creates its client with `createClient({ mode: "in-process" })` and the same
fetcher module the browser's worker loads. The fetcher context carries the
server's own address (`ExampleContext.origin`), because a server has no
origin to resolve the backend's paths against.

**Decision shown: coverage travels with the points.** In the browser,
`putSeeds` puts each seed with `put(batch, { range })`. A put that states its
range records the whole range as covered (§2.4), so every day in it without
a bar, the 26 weekends included, arrives as a confirmed empty day. The range
matters at the edges: a put without one claims only the span from its first
bar to its last (N3), so a window that starts on a weekend would leave those
days looking unfetched. The browser's
cache then knows what the server's knew, and its first `get` fetches only
what the server's answer did not cover: the provisional day. The log shows
that one fetch. It starts at the last seeded day, because a miss that abuts
coverage is extended by one interval into it (§2.5), and it ends tomorrow,
because `get` snaps the end of the window, now, outward to the next day
(§2.3).

**Decision shown: seeds never replace what the browser's cache covers.**
With a SharedWorker every tab of the origin shares one cache, and another
tab may hold those days from a fetch made after this page's server render.
`putSeeds` first asks the cache what it covers
(`get(range, { cacheOnly: true })`) and puts only the gaps. In a second tab,
the seeds find every day already covered by the first tab's worker, so
nothing is put.

**Decision shown: one server client for every render.** The server creates
its client on the first render, and every later render of the process
shares it and its cache. The first render fetches the half-year; later ones
read it from memory and fetch only the provisional day. The second line of
figures says how many of a render's bars came from the server's cache.
Reload the page and it goes from 0 to every final bar, all but a bar still
forming today.

That sharing suits public data only. Every visitor reads from the same
cache, so data that differs per user would leak between visitors; such data
needs a client per user, or no cache on the server. The cache is also never
trimmed: tscache v1 has no eviction, only `invalidate` and `clear` (§2.4),
so a server that reads many series or ever wider ranges needs its own policy
for clearing them. If creating the client fails, the server forgets the
failed attempt and the next render tries again.

## Hydration

`src/entry-client.tsx` reads both script elements and hydrates the server's
markup with `hydrateRoot`. Hydration only works if the browser's first
render produces the markup the server sent, and the page is built so it
does:

- The props travel as JSON (`jsonScript` and `readJson`), so the browser
  renders from the values the server rendered from. Nothing is recomputed in
  the browser before hydration, and no render reads the clock.
- Every figure has a fixed format: prices with `toFixed`, days as UTC dates.
  Locale-dependent formatting could differ between the server and the
  browser. A value that is not finite shows as a dash: NaN is a legal field
  value, and JSON brings it to the browser as `null`.
- State that only the browser has starts at the server's value: the fetch
  count at 0, the log empty (`useSyncExternalStore` with a server snapshot),
  and the status at `server-rendered`, which changes to `hydrating` right
  after hydration.
- The chart is created in an effect, which runs in the browser only, inside
  the container the server rendered. Lightweight Charts is imported there
  too, so it is not part of the bundle the page waits on to hydrate.

After hydration the page connects its client (`src/session.ts`), opens the
cache, puts the seeds and asks for the window. The figures then come from
the browser's cache, and the status reads `ready`.

## Scroll back

Drag the chart to the right: when the left edge of the view comes within
ten bars of the first one, the page asks for the half-year before. **Load
the half-year before** does the same without dragging. Either moves the
start of the window back 182 days and asks for the whole window again. The
cache fetches the uncovered older half-year in one request that ends where
the seeded days begin, and fetches the provisional day again, as every `get`
up to now does.

The new start is computed from the start of the window shown, not the one
last asked for, so the scroll events that keep coming while a half-year
loads all ask for that same half-year. Each answer draws only if no newer
request was made meanwhile, so a slow answer never draws over a later one.

## Losing the worker

Chromium runs a SharedWorker in the process of the tab that created it.
Crash that tab (type `chrome://crash` in its address bar) and the worker and
its cache go with it; every other tab's client emits `workerLost`. The page
then connects a new client, as `docs/guides/worker-setup.md` shows. The new
worker starts with an empty cache. The page does not put the seeds again:
they are as old as the page, and the new worker can fetch the window in one
request.

## What to watch

- With JavaScript turned off, the page still shows every figure and the
  table, read on the server; the status reads `server-rendered`.
- The log of a fresh tab reads, oldest first: the client connected
  (`shared`), the seeds from the server, and one fetch, from the last seeded
  day to tomorrow. The browser fetch count reads 1.
- Reload the page: the server line counts every final bar as read from the
  server's cache.

## Known limits

- A seed carries no dataset version, because the public `get` result does
  not report one. If the backend restated the series between the server's
  read and the browser's put, the seeded days would keep the old values,
  and nothing would detect it (§2.4: restatements without a version signal
  are undetectable).

## What else is in here

- `src/candles.ts` holds the cache config both sides share and the figures
  the page shows, computed by one function from a cache answer on both
  sides.
- `src/session.ts` keeps the client in React state and replaces it on
  `workerLost`, asks the cache for the window, and counts the fetches the
  backend received from the fetcher's notices.
- `src/Chart.tsx` creates the chart once and replaces its data with each
  answer; `src/candle-chart.ts` sets up Lightweight Charts 5, with volume in
  a pane of its own, and keeps the view in place when older bars are
  prepended.
