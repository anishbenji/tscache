# Vue 3.5

`series.ts` is the adapter an app copies. The plugin
`createTscache(open, seeds?)` connects once for the app
(`shared/connection.ts`), provides the connection under the `CONNECTION`
injection key, and disposes it in `app.onUnmount`, so `app.unmount()`
releases the client. A new client replaces one whose worker was lost.
`useSeries(config, range, initial?)` is a composable that returns readonly
refs: `answer`, the cache's answer for the latest range, which keeps the
previous answer while the next one loads; `pending`; and `error`, set when
the client cannot connect or a read fails on a live client.

```ts
createApp(App).use(createTscache(() => createClient(options))).mount("#app");

// In a component's setup:
const visible = shallowRef(lastDays(90, Date.now()));
const { answer, pending, error } = useSeries(candles, visible);
```

`chart.ts` is the view all three pages render. `client-only.ts` mounts it.
`ssr-server.ts` renders it on the server, and `ssr-browser.ts` hydrates it.
Without the browser's half, the server's half is a page rendered on the
server alone.

## Why these idioms

- The answer lives in a `shallowRef` and is returned through
  `shallowReadonly`, so the typed arrays are never made reactive or copied,
  and a chart gets the arrays the cache returned.
- Everything live starts in `onMounted`. That covers the bridge from
  `connection.state` to a `shallowRef`, released with `onScopeDispose`, and
  the `watch` over that state and the range. Vue never calls `onMounted` on
  the server, and a server render never unmounts, so a subscription made in
  setup would outlive the request. The hydration render also changes no ref,
  so it matches the server's markup whatever the view shows.
- Latest wins through `onWatcherCleanup`. A range change or a new client
  re-runs the watcher, which drops the previous read's answer. A read
  rejected because the worker was lost is not reported, since the next
  client reads again.
- The range goes through `toRaw`, because `ref()` makes a reactive proxy,
  and a worker cannot be posted one (`DataCloneError`).
- The server reads before rendering rather than in `onServerPrefetch`. The
  page's range comes from the request's `now`. The same read becomes the
  root props on both sides, so the hydration render matches by
  construction, and the composable needs no server code. The server installs
  no plugin and reads with `serverReader()` (`shared/server.ts`).
- Components use `defineComponent`'s function signature with `h()`, so
  `tsc` checks them; a `.vue` file needs vue-tsc.

## Known limits

- Move the range by giving a new object, as a `shallowRef` suits; a range
  changed in place is not seen.
- One page-level server read. A page whose components each choose their own
  range would read in `onServerPrefetch` and pass the reads through
  `useSSRContext`, keyed per component, which this snippet does not do.
- Installing the plugin on the server would connect for each request and
  never dispose, since a server app never unmounts.
- After hydration, `pending` is true while the browser reads the server's
  range to fetch the uncovered tail; a view that dims on `pending` dims
  briefly.
- A read that a newer one overtakes is dropped, not cancelled. `get` takes
  no abort signal, and its fetch still fills the cache.
- A seed carries no dataset version (see `examples/react-ssr/README.md`,
  "Known limits").
- `open` runs per client, so it can read current credentials. For
  `authInvalid` misses and `updateAuth`, see
  `examples/react-lwcharts/src/auth-refresh.ts`; `inject(CONNECTION)` gives
  the client.
