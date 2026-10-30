# Angular 22.2

`tscache.ts` is the adapter an app copies. `provideTscache(open, options?)`
gives the root service `Tscache` its `open`. The service connects once, in
the browser only (`shared/connection.ts`), exposes the connection's `state`
as a signal, and disposes the connection through the root `DestroyRef`, so
destroying the app releases the client. A new client replaces one whose
worker was lost. `cacheResource(config, range)` returns a `Resource` of the
cache's answer for the latest range. It keeps the previous answer while the
next one loads, and sets `error()` when the client cannot connect or a read
fails on a live client.

```ts
bootstrapApplication(CandlesChart, clientConfig(options));          // client-only
bootstrapApplication(CandlesChart, mergeApplicationConfig(browserConfig(options),
  { providers: [provideClientHydration()] }));                       // hydrating
const server = { providers: [provideServerRendering(), provideClientHydration(),
  provideTscacheServer({ fetcherModule, origin })] };                // once per process
renderApplication((context) => bootstrapApplication(CandlesChart, server, context),
  { document, url, allowedHosts });                                  // per request
```

`candles-chart.ts` is the component every variant renders, unchanged. Only
the providers differ: `client-only.ts`, `ssr-browser.ts` and `ssr-server.ts`.
Without the browser's half, the server's half is a page rendered on the
server alone.

## Why these idioms

- `resource()` gives latest wins. The connection's state is in its params,
  so a new client starts a new read and the read in flight is dropped. A
  lost worker's client emits `workerLost` before its rejected reads are
  handled, so that rejection is dropped too and never reaches `error()`.
  While connecting, the params throw `ResourceParamsStatus.LOADING`.
- The previous answer stays on screen through Angular's own
  `withPreviousValue` recipe: `linkedSignal` over `snapshot`, then
  `resourceFromSnapshots`. Signals hold references, so the typed arrays are
  never copied or made deeply reactive.
- On the server, `cacheResource` reads through `SERVER_READER`, which
  `provideTscacheServer` provides with the process's `serverReader`. The
  resource holds a pending task while it loads, so the zoneless render waits
  for the read. The reader writes the read into `TransferState` under
  `makeStateKey<Dehydrated>`, and Angular escapes it into the page.
- In the browser, `hydrate: [candles]` makes the service rehydrate that
  read, seed every client with it, and hand it to the first
  `cacheResource` as its first value. The hydration render then matches
  the server's markup, and the live read fetches only what the read did
  not cover.
- `resource({ id })` would transfer the value as JSON, which cannot carry
  typed arrays or NaN, and it would not seed the browser's cache.
- `Tscache` is a root singleton declared with Angular 22's `@Service()`, and
  dependencies come from `inject()`. The component is standalone and `OnPush`. Its text
  is a `computed`, because `tsc` does not check templates (ngc would).

## Known limits

- `resourceFromSnapshots` is experimental in Angular 22.
- One server read per cache per page: the key is the cache id.
- The chart's range comes from `Date.now()` on each side. `get` snaps it
  outward to whole days, so both ask for the same days except across
  midnight UTC.
- After hydration, `status()` is `"loading"` until the live answer lands.
- `get` takes no abort signal, so an overtaken read is dropped, not
  cancelled. Its fetch still fills the cache.
- A seed is checked against the dataset version only when the dataset has
  one (`../README.md`, "Checks and limits"; architecture §2.8).
- `open` runs once per client, so it can read current credentials. For
  `authInvalid` and `updateAuth`, see
  `examples/react-lwcharts/src/auth-refresh.ts`. The client is
  `inject(Tscache).state()` when connected.
