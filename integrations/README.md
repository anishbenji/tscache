# Integration snippets

How to wire tscache into an application, one folder per framework, each in a client-only and a
server-rendered variant with hydration (starter §7). They are source to copy, not a package: nothing
here is published. Every snippet type-checks against the built package
(`bun run build && bun run check:integrations`).

tscache couples to a framework in two places only: the client's lifecycle, and the step from a
promise to the framework's reactivity. The lifecycle is the same everywhere, so it lives once in
`shared/`; each framework folder adds the second step in its own idiom.

## The shared core (`shared/`)

- `connection.ts`: `connect(open, seeds?)` connects once, replaces the client when the worker behind it
  is lost (a crashed tab hosting the SharedWorker), and disposes it on teardown. Every client, a
  replacement included, gets the server's seeds: `hydrate` refuses a snapshot of another dataset
  version and never touches what a cache covers (architecture §2.8, N39).
  `open` runs once per client, so it can read the fetcher's current credentials.
- `hydration.ts`: `dehydrate` and `rehydrate` carry a server's read through JSON: its columns (typed
  arrays as base64, so NaN survives), which the hydration render shows, and its snapshot
  (`encodeSnapshot`); `hydrateRead`, which `connection.ts` calls, applies the snapshot with
  `cache.hydrate`, which fills only what the browser's cache does not cover yet, so the browser
  fetches only the rest, such as a provisional tail.
- `server.ts`: `serverReader(options)` reads through one in-process client per server process, shared
  by every render. Every visitor reads the same cache: public data only.
- `candles.ts`: the dataset every snippet shows, and the one line of text that stands in for a chart.

## The frameworks

| Folder | Adapter | Promise to reactivity | Server's read reaches the browser as |
|---|---|---|---|
| `vanilla/` | `series(connection, options)` | a request counter: latest wins | a JSON script element |
| `react/` | `TscacheProvider`, `useSeries` | `use()` under Suspense, inputs through `useDeferredValue` | a JSON script element |
| `solid/` | `createConnection`, `createSeries` | an async `createMemo` (Solid 2.0 RC) | a JSON script element |
| `vue/` | `createTscache` plugin, `useSeries` | `watch` with `onWatcherCleanup` into `shallowRef`s | a JSON script element |
| `svelte/` | `tscacheContext`, `Series` | `$effect` into `$state.raw`, `createSubscriber` | a JSON script element, then props |
| `angular/` | `provideTscache`, `cacheResource` | `resource()` | `TransferState` |

Each framework folder has a README on its idioms and limits. The vanilla snippet is `vanilla/series.ts`
(a series shows the answer for the latest range it was asked for and drops answers a newer range has
overtaken), `client-only.ts`, and `ssr-server.ts` with `ssr-browser.ts`.

## What every snippet keeps

- One connection per app, created where the framework keeps app-lifetime things, disposed with the app.
  A page that simply closes needs no teardown: a client disposes itself on `pagehide`.
- Reads go through `connection.cache(client, config)`, which opens each cache once per client.
- Only the latest range's answer shows, and the previous answer stays on screen while the next loads.
- A read rejected because the worker was lost is not an error; the next client reads again. A
  connection that failed, or a read that failed on a live client, is surfaced the framework's way.
- Typed arrays are never made deeply reactive or copied.
- A server-rendered page's hydration render shows the server's read, so it matches the server's markup;
  the live answer then replaces it. The server half and the browser half are separate files, so no
  server code reaches the browser bundle. Without the browser half, a page is rendered on the server
  alone.

## Checks and limits

The shared core and the vanilla snippet run under Vitest (`integrations/test/`). The framework
snippets are type-checked only in CI; during step ⑭ each was also run in throwaway probes (the server
half under Node or Bun, the browser half in Chromium) whose results are recorded in
`docs/reviews/step-14.md`. Svelte and Angular templates, and the Svelte component in its README, are
not type-checked.

Limits every variant shares:

- A seed carries no dataset version, and checking what the browser's cache covers and putting the
  seed are two requests: another tab's fetch landing between them is replaced by the seed. Either
  matters only if the backend changed covered history after the server's read. Closing both needs a
  library-level snapshot API (`docs/roadmap.md`, post-build architecture review).
- `get` takes no abort signal: an overtaken read is dropped, not cancelled, and its fetch still fills
  the cache.
- Reading a range again (after `updateAuth`, say) means asking for it again: the vanilla series reads
  on each `show`, and the Solid, Vue, Svelte and Angular adapters read again when given a new range
  object. React's `useSeries` caches answers by range value, so it reads again only for a new range or
  a new client. The reference clients on the roadmap add the credential refresh; until then,
  `examples/react-lwcharts/src/auth-refresh.ts` shows `authInvalid` with Web Locks.
