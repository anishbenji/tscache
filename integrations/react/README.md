# React

tscache in React 19: `TscacheProvider` gives the app's one connection
(`shared/connection.ts`) to the components below it, and
`useSeries(config, range)` returns the cache's answer for a range,
suspending until there is one. `page.tsx` is the page both sides render;
`client-only.tsx`, `ssr-server.tsx` and `ssr-browser.tsx` start it.

## Use

Create the connection before the first render and dispose it after the
root unmounts (`client-only.tsx`). Wrap the app in
`<TscacheProvider connection={connection}>`, put each chart inside a
`Suspense` boundary and an error boundary, and call `useSeries` with a
config that is a module constant and the range on screen. Set the range
however the chart reports it; no transition is needed.

With server rendering, the server reads first, then renders with
`<TscacheProvider connection={null} seeds={[{ config, read }]}>` and writes
the read into the page (`ssr-server.tsx`). The browser rehydrates the read,
passes the same seeds to `connect` and to the provider, and hydrates
(`ssr-browser.tsx`). Without the browser half, the page is server-rendered
only.

## Why it is shaped this way

- The connection lives outside React, where app-lifetime resources belong:
  StrictMode runs effects twice, so an effect would open a second client.
- The connection's state reaches React through `useSyncExternalStore`. A
  store update cannot be a transition, so suspending on it directly would
  replace the chart with the fallback on every reconnect (react.dev,
  `useSyncExternalStore` caveats). The hook passes the state, the config
  and the range through `useDeferredValue`: a new client, cache or range
  loads in a background render while the previous answer stays on screen.
  React drops a background render that a newer range overtook, so an
  overtaken answer never shows. Only a first answer shows the fallback.
- `use()` needs the same promise on every render of a read, a suspended
  render's retry included. Reads are cached per client, config and range,
  and none is dropped during a render: a pending or shown read stays, any
  other goes 30 s after it settled or was last shown (like TanStack
  Query's `gcTime`). A read made while connecting belongs to the client it
  awaited. A config conflicting with another of its id fails its own
  reads with `ConfigError`.
- A read rejected because the worker was lost is asked again of the client
  replacing it, so it never reaches an error boundary. A failed connection,
  or a read that failed on a live client, throws to the nearest one.
- The server must not suspend on tscache. Its read reaches `useSeries`
  through the provider; with `useSyncExternalStore`'s server snapshot, the
  server's render and the browser's hydration render both show it, so the
  markup matches. Then the browser's answer replaces it in the background.
- `renderToString`: the server reads before it renders, so nothing suspends
  and a stream would have nothing to stream.

## Known limits

- An answer is cached for its range: the hook does not read that range
  again, so misses (`fetch-failed`, `auth-pending`) and a provisional tail
  stay as they were until the range or the client changes. After
  `updateAuth`, change the range to read again. For `authInvalid` and Web
  Locks, see `examples/react-lwcharts/src/auth-refresh.ts`.
- Memory holds every range read in the last 30 s; a boundary waiting over
  30 s on one read may read its other ranges again. A failed read is kept
  as long, so an error boundary's retry within that time repeats it.
- The hook has no pending flag. To show one, set the range in
  `startTransition` from `useTransition` and read `isPending`.
- The server reads one range per cache id and matches it by id alone, so
  a config conflicting with the seed's shows the seed, then `ConfigError`.
  With no server read, React renders that boundary's fallback on the
  server; the browser renders it, logging a recoverable error.
- The provider keeps the seeds for the life of the page.
