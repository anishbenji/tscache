# Demo hub

Every example app and reference client in the repository runs from one command, from a clone:

```sh
bun install
bun run demo
```

It builds the package and each app, serves every app on its own local port with its own mock backend,
and opens a hub at <http://127.0.0.1:5400/> (`DEMO_PORT` moves it; the apps take the next ten
ports). Each app is its own origin, so each has its own SharedWorker. Ctrl-C stops everything.

The hub lists every page: client-only and server-rendered, both chart libraries, and the
Server-Sent Events, WebSocket and polling feeds. Each entry says what the page shows and what to
try, such as opening it in a second tab or crashing the tab that hosts the worker. Below the entries,
a panel shows each mock backend's counters as they change: the fetches it answered, requests refused
for an expired token, token refreshes and open streams. Its buttons expire a backend's token, drop
its live streams or restate its history.

What to watch for:

- **Multi-tab sharing.** Open a page twice: the second tab draws at once, and the backend's fetch
  count grows by the newest bars at most. See [Workers and fallback](/guides/workers).
- **Credential refresh.** Expire a token from the panel: one tab refreshes it for every tab, and the
  backend counts one refresh. See [Credentials and refresh](/guides/auth).
- **Server rendering.** The SSR pages arrive with the server's read, and the browser fetches only
  what is still forming. See [Server rendering](/guides/ssr).
- **Live feeds.** Drop the streams from the panel: the feed reconnects and mends the bars it missed.
  See [Live feeds](/guides/live-feeds).
- **Cache or network.** Every page labels the read on screen: how many of its bars came from the
  cache and how many from the network, and its time to chart (from `get()` to the frame after the
  chart library drew it), with the median and the 95th percentile of the page's reads.
- **The benchmark.** The Benchmark entry runs one workload with no cache, a per-tab memo keyed by
  exact range, TanStack Query with exact-range keys per tab, and tscache, and tabulates the backend
  requests, the views answered without a request, bars, bytes and time to chart of each. The
  numbers the documentation quotes come from `docs/benchmarks/demo-comparison.md`, which
  `bun scripts/demo-bench.ts` generates.

Recordings of four of these, multi-tab sharing, credential refresh, server rendering and the live-feed
reconnect, each on the vanilla reference client, are on the pages that explain them: sharing on
[What tscache is](/), the refresh under [Refreshing once across tabs](/guides/auth#refreshing-once-across-tabs),
server rendering on [Server rendering](/guides/ssr) and the reconnect under
[Catching up after a gap](/guides/live-feeds#catching-up-after-a-gap). They were recorded headless
with Playwright and converted with ffmpeg into the GIFs the README shows (`docs/media/`) and the videos
the site shows (`site/public/media/`); the script that records them again lands in a later step.

The launcher is
[`scripts/demo.ts`](https://github.com/anishbenji/tscache/blob/main/scripts/demo.ts), and the hub's
list of pages is
[`scripts/demo/catalog.ts`](https://github.com/anishbenji/tscache/blob/main/scripts/demo/catalog.ts).
