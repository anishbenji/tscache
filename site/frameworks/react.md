# React

The React snippet targets React 19: `TscacheProvider` gives the app's one
[connection](/frameworks/vanilla#the-connection) to the components below it, and
`useSeries(config, range)` returns the cache's answer for a range, suspending until there is one.

## Use

Create the connection before the first render, outside React, and dispose it after the root unmounts:
StrictMode runs effects twice, so an effect would open a second client.

<<< ../../integrations/react/client-only.tsx{tsx}

Put each chart inside a `Suspense` boundary and an error boundary, and call `useSeries` with a config
that is a module constant and the range on screen:

<<< ../../integrations/react/page.tsx{tsx}

## How the hook works

- The connection's state reaches React through `useSyncExternalStore`. The hook passes the state, the
  config and the range through `useDeferredValue`, so a new client, cache or range loads in a background
  render while the previous answer stays on screen, and an overtaken answer never shows. Only a first
  answer shows the fallback.
- `use()` needs the same promise on every render of a read, so reads are cached per client, config and
  range; one that is neither pending nor shown is dropped 30 s after it settled or was last shown.
- A read rejected because the worker was lost is asked again of the replacing client, so it never
  reaches an error boundary.
- An answer is cached for its range: after `updateAuth`, change the range to read again.

<<< ../../integrations/react/series.tsx{tsx}

## Server rendering

The server reads before it renders, so nothing suspends, and passes the read to the provider as a seed;
`useSyncExternalStore`'s server snapshot makes the server's render and the browser's hydration render
show it, so the markup matches. The browser then replaces it with its own answer.

<<< ../../integrations/react/ssr-server.tsx{tsx}

<<< ../../integrations/react/ssr-browser.tsx{tsx}

The snippet's [README](https://github.com/anishbenji/tscache/blob/main/integrations/react/README.md) lists its limits.

## Complete apps

- [`reference/react`](https://github.com/anishbenji/tscache/tree/main/reference/react): the reference client, with the session bound through
  `useSyncExternalStore` and the chart drawn in effects on a ref'd element.
- [`examples/react-lwcharts`](https://github.com/anishbenji/tscache/tree/main/examples/react-lwcharts): two tabs on one SharedWorker, a visible fetch
  counter, and the token refresh across tabs.
- [`examples/react-ssr`](https://github.com/anishbenji/tscache/tree/main/examples/react-ssr): server-rendered candles.
