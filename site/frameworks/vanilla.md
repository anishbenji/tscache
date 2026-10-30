# Vanilla JavaScript

tscache couples to a framework in two places only: the client's lifecycle, and the step from a promise to
the framework's reactivity. The [integration snippets](https://github.com/anishbenji/tscache/tree/main/integrations) put the lifecycle in one
framework-neutral module and add the second step per framework. Every snippet type-checks against the
built package in CI; copy them into your app.

## The connection

`connect(open, seeds?)` connects once, replaces the client when its worker is lost, and disposes it on
teardown. `open` runs once per client, so it can read the fetcher's current credentials. `seeds` are a
server's reads to start each client's cache from ([Server rendering](/guides/ssr)).

<<< ../../integrations/shared/connection.ts{ts}

## A series

A series shows the cache's answer for the latest range it was asked for, and drops answers a newer range
overtook. A read rejected because the worker was lost is not an error: the next client reads again.

<<< ../../integrations/vanilla/series.ts{ts}

## A client-only page

<<< ../../integrations/vanilla/client-only.ts{ts}

## Server-rendered

The server's half reads with one in-process client per process and writes the answer as markup and as a
JSON script element:

<<< ../../integrations/vanilla/ssr-server.ts{ts}

The browser's half keeps the server's markup until its own answer arrives, and seeds its cache:

<<< ../../integrations/vanilla/ssr-browser.ts{ts}

The helpers they use are [`integrations/shared/server.ts`](https://github.com/anishbenji/tscache/blob/main/integrations/shared/server.ts) and
[`integrations/shared/hydration.ts`](https://github.com/anishbenji/tscache/blob/main/integrations/shared/hydration.ts).

## A complete app

The vanilla reference client ([`reference/vanilla`](https://github.com/anishbenji/tscache/tree/main/reference/vanilla)) adds scrolling, both chart
libraries, a live feed and the credential refresh; [`examples/vanilla-uplot`](https://github.com/anishbenji/tscache/tree/main/examples/vanilla-uplot)
is a live metrics dashboard with a volatile tail and a sparse event series.
