# Solid

The Solid snippet targets Solid 2.0 (release candidate 14) with `@solidjs/web`. Solid 2 removed
`createResource`, so a series is an async memo.

## The adapter

- `createConnection(open, seeds?)` connects once and disposes the client when the calling owner is
  disposed. Call it in the app's root component and provide the result with
  `<ConnectionContext value={connection}>`.
- `createSeries(connection, config, range, { initial }?)` returns an accessor for the cache's answer for
  `range()`. Put a chart under `<Errored>`, and under `<Loading>` unless it has `initial`.

<<< ../../integrations/solid/series.ts{ts}

The series is one `createMemo` over the range and the connection's state. Solid's async memo does
latest-wins: a new range drops the run in flight, and after the first answer the previous one stays on
screen with `isPending(answer)` true. A memo, unlike a store, neither proxies nor copies the typed arrays.
A lost worker moves the connection to `connecting`, which runs the memo again, and the replacement client
reads.

## Pages

<<< ../../integrations/solid/page.tsx{tsx}

<<< ../../integrations/solid/client-only.tsx{tsx}

## Server rendering

The server reads, renders the page with `renderToString` and writes the read into the page. The browser
hydrates the same page showing the server's read, then mounts the live chart, seeded with the read and
given it as `initial`, so the chart shows the server's answer at once and fetches at most the uncovered
tail.

<<< ../../integrations/solid/ssr-server.tsx{tsx}

<<< ../../integrations/solid/ssr-browser.tsx{tsx}

The snippet's [README](https://github.com/anishbenji/tscache/blob/main/integrations/solid/README.md) lists its limits; Solid 2 is a release
candidate, and its APIs may change before 2.0.

## Complete apps

- [`reference/solid`](https://github.com/anishbenji/tscache/tree/main/reference/solid): the reference client.
- [`examples/solid-lwcharts`](https://github.com/anishbenji/tscache/tree/main/examples/solid-lwcharts): OHLCV scroll-back over nights and weekends.
- [`examples/solid-uplot`](https://github.com/anishbenji/tscache/tree/main/examples/solid-uplot): a sensor with dropout gaps and an integer field.
- [`examples/solid-ssr`](https://github.com/anishbenji/tscache/tree/main/examples/solid-ssr): a server-rendered sensor.
