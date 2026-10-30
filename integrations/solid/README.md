# tscache with Solid 2

The adapter (`series.ts`) and the pages that use it, client-only and
server-rendered, for Solid 2.0.0-rc.14 with `@solidjs/web`. Solid 2 removed
`createResource`, so a series is an async memo.

## The adapter

- `createConnection(open, seeds?)` connects once and disposes the client
  when the calling owner is disposed. Call it in the app's root component
  and provide the result with `<ConnectionContext value={connection}>`.
- `createSeries(connection, config, range, { initial }?)` returns an
  accessor for the cache's answer (`{ range, result }`) for `range()`. Put
  a chart under `<Errored>`, and under `<Loading>` unless it has `initial`.

```tsx
function Chart() {
  const [range, setRange] = createSignal(lastDays(90, Date.now()));
  const answer = createSeries(useContext(ConnectionContext), candles, range);
  // The chart library takes answer().result and calls setRange on scroll.
  return <p aria-busy={isPending(answer) ? "true" : undefined}>{describe(answer().result)}</p>;
}
```

## Why these idioms

- The series is one `createMemo` over the range and the connection's state,
  a signal fed by `connection.subscribe` and released with `onCleanup`.
  Solid's async memo does latest-wins. A new range drops the run in flight,
  so an overtaken answer never lands. After the first answer, the previous
  answer stays on screen with `isPending(answer)` true, and no fallback shows.
  A memo, unlike a store, neither proxies nor copies the typed arrays.
- A lost worker is not an error. Its loss moves the connection to
  `connecting`, which runs the memo again; a read the lost client rejected
  then stays pending, so Solid drops it as overtaken whatever order the
  rejection and the state change arrive in, and the replacement client
  reads again. A failed connection, and a read that fails on a live client,
  throw to `<Errored>`.
- `createSeries` takes the connection and components read the context,
  because Biome's `useHookAtTopLevel` rule, written for React, rejects
  `useContext` outside a component.

## Server rendering

`ssr-server.tsx` reads with the process's in-process client, renders
`page.tsx` with `renderToString`, and writes Solid's hydration script, the
markup and the dehydrated read. `ssr-browser.tsx` rehydrates the read and
hydrates the same `Page`, which renders the server's read until hydration
settles, so hydration claims the server's markup. Then `onSettled` flips a
signal and `Show` mounts the live chart, created only now so it cannot
shift Solid's hydration ids. It connects with the read as the first
client's seed and passes it as `initial`, the memo's `loadingValue`. The
chart shows the server's answer at once, then its own, which costs at most
the uncovered tail. Without `initial`, Solid would hold the switch until
the first live answer, and a chart library could not draw before the
worker answered. SSR-only is `ssr-server.tsx` without the browser half.

## Known limits

- Solid 2 is a release candidate; `loadingValue`, `onSettled` and the
  boundaries may change before 2.0.
- The live chart replaces the server's element with its own as hydration
  ends, with the same text.
- Teardown does not wait for the client's `dispose()`, since a cleanup
  cannot be async; a rejection from it goes unhandled.
- The JSX needs Solid's compiler (`vite-plugin-solid` with Vite); `tsc` only
  type-checks it.
- A seed is checked against the dataset version only when the dataset has
  one (`../README.md`, "Checks and limits"; architecture §2.8).
- `open` runs once per client, so it can read current credentials. For
  `authInvalid`, see `examples/react-lwcharts/src/auth-refresh.ts`.
