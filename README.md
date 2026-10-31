# tscache

Browser time-series cache: SharedWorker multi-tab sharing, worker-side fetch
orchestration, and coverage tracking that distinguishes "not fetched yet" from
"confirmed empty" (weekends, sensor dropouts).

**Status: pre-release.** The design is settled; see
[`docs/architecture.md`](docs/architecture.md) for the API surface, RPC
protocol and decision register, and [`docs/roadmap.md`](docs/roadmap.md) for
what v1 leaves out. The questions deferred to the review after the build are
in [`docs/architecture-review.md`](docs/architecture-review.md); their
decisions are rows N34–N44 of the decision register.

## Documentation

The user documentation is a VitePress site in [`site/`](site/): getting
started, the concepts, every public API with an example, guides, framework
and chart wiring, performance, troubleshooting, and an API reference
generated from the TSDoc. Build or serve it locally:

```sh
bun install
bun run docs:dev     # serves it with live reload
bun run docs:build   # builds it into site/.vitepress/dist
```

## Guides

- [`docs/guides/worker-setup.md`](docs/guides/worker-setup.md): serving the
  worker and fetcher with Vite, webpack or no bundler; server rendering.
- [`docs/guides/patterns.md`](docs/guides/patterns.md): what tscache leaves to
  the application (expiry, restatements, credentials, a lost worker) and the
  limits to design around.

## Examples

Runnable apps under [`examples/`](examples/), each a narrative page on the
design decision it demonstrates. They share a synthetic backend
([`examples/mock-backend`](examples/mock-backend)) that every example's Vite
server mounts under `/api/`.

| App | Scenario |
|---|---|
| [`vanilla-uplot`](examples/vanilla-uplot) | Live server metrics with a volatile tail; sparse event counts |
| [`solid-uplot`](examples/solid-uplot) | IoT sensor with dropout gaps and an integer field |
| [`solid-lwcharts`](examples/solid-lwcharts) | OHLCV scroll-back over nights and weekends |
| [`react-lwcharts`](examples/react-lwcharts) | Two tabs, one SharedWorker; token refresh across tabs |
| [`react-ssr`](examples/react-ssr) | Server-rendered candles; the browser's cache hydrated from the server's read |
| [`solid-ssr`](examples/solid-ssr) | Server-rendered sensor; confirmed gaps travel with the coverage |

```sh
bun install && bun run build
bun run --cwd examples/vanilla-uplot dev
```

### Demo hub

`bun run demo` builds the package, every example and every reference client,
serves each on its own local port with its own mock backend, and opens a hub
at <http://127.0.0.1:5400/> (`DEMO_PORT` moves it; the apps take the next nine
ports). The hub links every page, client-only and server-rendered, both chart
libraries and all three live feeds, says what each one shows, and has a live
panel of every backend's counters (fetches, refused requests, token refreshes,
open streams) with buttons to expire a token, drop the live streams or restate
history. Open a page twice to watch two tabs share one SharedWorker: the second
tab draws at once and adds at most the newest bars to the fetch count. Ctrl-C stops everything.

## Framework integrations

Type-checked snippets under [`integrations/`](integrations/) for vanilla
JavaScript, React, Solid, Vue, Svelte and Angular, each client-only and
server-rendered with hydration. They share a small framework-neutral core:
the client's lifecycle (connect once, replace it when its worker is lost,
dispose on teardown) and the hydration of a server's read. A framework adds
only the step from a promise to its own reactivity.

## License

[MIT](LICENSE)
