# Workers and fallback

## The hosting chain

The engine runs in one of three hostings, tried in order from `mode` (default `'shared'`):

1. **`'shared'`**: a `SharedWorker`. Every same-origin tab connects to the same worker, so they read
   one cache and share every fetch. This is the point of tscache.
2. **`'dedicated'`**: a `Worker` per tab. Each tab has its own cache; the work still runs off the main
   thread.
3. **`'in-process'`**: an engine in the page itself, behind the same message protocol. No sharing.

A hosting **fails**, and the chain steps down with a `modeFallback` event, when its constructor throws
(Chrome on Android has no `SharedWorker`), when the worker fires `error` before the handshake (the script
failed to load or threw), or when no hello arrives within `handshakeTimeoutMs`. When the last hosting
fails, `createClient` rejects. A `ProtocolMismatchError` never steps down: it is a real
incompatibility.

::: info Chrome on Android
Chrome on Android has no `SharedWorker`. There the client falls back to a dedicated worker per tab, with
one `modeFallback` event. Nothing to configure, but each tab then has a cache of its own: a clear stays
in its tab, and a range is fetched once per tab.
:::

<<< @/snippets/client.ts#fallback{ts}

## Serving the worker script

`workerUrl` is the `tscache/worker` script as your setup serves it. The browser resolves it at runtime,
so a bare package specifier does not work. The worker is an ES module worker (`{ type: 'module' }`) and
must be same-origin: a worker script on another origin is refused.

### Vite

<<< @/snippets/getting-started.ts#client{ts}

### webpack 5 and Rspack

webpack bundles a worker only when it sees `new Worker(new URL(...))` in your code, and `createClient`
creates the worker itself; a bare `new URL("tscache/worker", import.meta.url)` emits the entry file
without the chunks it imports. Serve the whole `dist/` directory instead, for example with
`copy-webpack-plugin`:

```js
// webpack.config.js
import CopyPlugin from "copy-webpack-plugin";
export default {
  plugins: [
    new CopyPlugin({
      patterns: [{ from: "node_modules/tscache/dist", to: "vendor/tscache" }],
    }),
  ],
};
```

```ts
const client = await createClient({ workerUrl: "/vendor/tscache/worker.js" });
```

### No bundler

Serve `node_modules/tscache/dist/` (the worker and the chunks beside it) from your origin and pass
`/vendor/tscache/worker.js`, as above.

### Checking the setup

`client.mode` is `'shared'`, or `'dedicated'` where SharedWorker is missing, when the URL resolved. An
unexpected `'in-process'` means both workers failed: listen for `modeFallback` during development to
see why.

## Stale scripts after a deploy

The worker reports its protocol version on connect, and the client refuses a mismatch with
`ProtocolMismatchError`. This catches a stale worker script, cached or kept alive by a tab opened before
an upgrade. Reloading the page fixes it once the old tabs are closed.

## Losing the worker

Chromium runs a SharedWorker in the process of the tab that created it. If that tab crashes, the worker
and its cache go with it, and the other tabs get no `error` and no port closure. tscache detects it with
a Web Lock that the worker holds for its lifetime: every other tab's client then rejects its pending and
later calls with `TscacheError` and emits `workerLost` once. Create a new client to go on; it starts a
new worker with an empty cache.

<<< @/snippets/client.ts#lost{ts}

The integration snippets' `connect` does this for every framework
([`integrations/shared/connection.ts`](https://github.com/anishbenji/tscache/blob/main/integrations/shared/connection.ts)).

Detection needs Web Locks, so a secure context (HTTPS or `localhost`); elsewhere the calls of those tabs
hang. It assumes two things:

- No script of your origin takes the worker's lock. Its name is readable with
  `navigator.locks.query()`; a script that requests it with `steal: true` makes every client report
  `workerLost` while the worker runs on, and a recovery loop then reconnects until the last tab closes.
- The fetcher never closes its worker. A dedicated worker that calls `self.close()` fires no `error`,
  so the calls of its tab hang.

A dedicated worker that fails after the handshake rejects its tab's pending calls and reports
`workerLost` too.

## Tabs that close

A client disposes itself on `pagehide` (unless the page enters the back/forward cache), since browsers
tell a SharedWorker nothing when a tab closes. A tab whose renderer dies without `pagehide` stays
registered in the worker until the worker ends with the last tab: a small, bounded leak.
