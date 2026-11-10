# Workers and fallback

## The hosting chain

The engine runs in one of three hostings, tried in order from `mode` (default `'shared'`):

1. **`'shared'`**: a `SharedWorker`. Every same-origin tab connects to the same worker, so they read
   one cache and share every fetch. This is the point of tscache.
2. **`'dedicated'`**: a `Worker` per tab. Each tab has its own cache; the work still runs off the main
   thread.
3. **`'in-process'`**: an engine in the page itself, behind the same message protocol. No sharing.

A hosting **fails**, and the chain steps down with a `modeFallback` event, when its constructor throws
(a browser without `SharedWorker`, see [Browser support](#browser-support)), when the worker fires `error` before the handshake (the script
failed to load or threw), when no hello arrives within `handshakeTimeoutMs`, or when a SharedWorker
stops running after its hello but before the handshake completes (reason: "SharedWorker stopped running
during the handshake"). When the last hosting
fails, `createClient` rejects. A `ProtocolMismatchError` never steps down: it is a real
incompatibility.

`handshakeTimeoutMs` bounds only the wait for hello. Once the worker has said hello, it loads your
`fetcher` module, and that load is not bounded by the timeout: a slow import delays `createClient`
but does not step down. A fetcher module that fails to load rejects `createClient` with a
`TscacheError` (`init-err`) naming the module, without falling back. A load that never settles leaves
`createClient` pending: tscache 0.1.0 has no timeout on it ([Writing a fetcher](/guides/fetcher)).

::: info Browsers without SharedWorker
Samsung Internet and Opera Mobile have no `SharedWorker`, nor had Chrome for Android before version 148.
There the client falls back to a dedicated worker per tab, with one `modeFallback` event. Nothing to
configure, but each tab then has a cache of its own: a clear stays in its tab, a range is fetched once
per tab, `authInvalid` and `updateAuth` reach only that tab ([Authentication](/guides/auth)), and
`persist: true` stores nothing ([Persistence](/guides/persistence)). `client.mode` is then
`'dedicated'`.
:::

<<< @/snippets/client.ts#fallback{ts}

## Browser support

First version of each browser that supports what each hosting needs, from MDN browser-compat-data 8.1.8,
[caniuse](https://caniuse.com/sharedworkers) and
[Chrome Platform Status](https://chromestatus.com/feature/6265472244514816), read 2026-11-10:

| Feature                 | Chrome | Edge | Firefox | Safari | Chrome Android | Safari iOS | Firefox Android | Samsung Internet | Android WebView |
| ----------------------- | ------ | ---- | ------- | ------ | -------------- | ---------- | --------------- | ---------------- | --------------- |
| `SharedWorker`          | 5      | 79   | 29      | 16     | 148            | 16         | 33              | No               | 148             |
| Module dedicated worker | 80     | 80   | 114     | 15     | 80             | 15         | 114             | 13.0             | 80              |
| Module `SharedWorker`   | 80     | 80   | 114     | 16     | 148            | 16         | 114             | No               | 148             |
| `import()` in workers   | 80     | 80   | 114     | 15     | 80             | 15         | 114             | 13.0             | 80              |
| Web Locks in workers    | 69     | 79   | 96      | 15.4   | 69             | 15.4       | 96              | 10.0             | 69              |
| IndexedDB in workers    | 24     | 12   | 37      | 10     | 25             | 10         | 37              | 1.5              | 4.4             |

Chrome for Android and Android WebView ran `SharedWorker` as an origin trial in versions 140 to 144 and
shipped it in 148. What the gaps mean for the chain:

- **No `SharedWorker`** (Samsung Internet, which is based on Chromium 143 at version 30; Opera Mobile;
  Chrome for Android and WebView before 148): the shared hosting fails and the client runs a dedicated
  worker per tab, with the per-tab differences in the note above.
- **No module workers** (Firefox before 114): both worker hostings fail, since the worker is an ES module
  worker, and the client runs in-process.
- **Web Locks** are used only by the shared hosting, to detect a lost worker
  ([Losing the worker](#losing-the-worker)). Every browser version above that runs a module
  `SharedWorker` also has Web Locks in workers. Safari 15.0 to 15.3 has no Web Locks, but it has no
  `SharedWorker` either: it runs the dedicated hosting, which learns of a failed worker from the
  worker's `error` event. Outside a secure context Web Locks are missing in every browser, with the
  consequence described under [Losing the worker](#losing-the-worker).

The repository's browser tests run in Chromium only; no other column of this table is tested by the
project.

## Serving the worker script

`workerUrl` is the `@anishbenji/tscache/worker` script as your setup serves it. The browser resolves it at runtime,
so a bare package specifier does not work. The worker is an ES module worker (`{ type: 'module' }`) and
must be same-origin: a worker script on another origin is refused.

### Vite

<<< @/snippets/getting-started.ts#client{ts}

The worker loads its persistence code with `import()`, only once a cache with `persist: true` opens or
`clearAll` runs (in a dedicated worker or in-process, at `clearAll` only, to empty the database). Vite's default worker format, `'iife'`, inlines it into the worker file, where it is
downloaded but not run; with `worker: { format: "es" }` in `vite.config.ts` it is a chunk of its own,
which an app that persists nothing never downloads ([the Vite plugin](/guides/vite) warns in
`vite build` when the format is `'iife'`). Pass the URL as Vite gives it: the chunks import the
worker file by that URL, so a query added to it would load the worker twice.

### webpack 5 and Rspack

webpack bundles a worker only when it sees `new Worker(new URL(...))` in your code, and `createClient`
creates the worker itself; a bare `new URL("@anishbenji/tscache/worker", import.meta.url)` emits the entry file
without the chunks it imports. Serve the whole `dist/` directory instead, for example with
`copy-webpack-plugin`:

```js
// webpack.config.js
import CopyPlugin from "copy-webpack-plugin";
export default {
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: "node_modules/@anishbenji/tscache/dist", to: "vendor/tscache" },
      ],
    }),
  ],
};
```

```ts
const client = await createClient({ workerUrl: "/vendor/tscache/worker.js" });
```

### No bundler

Serve `node_modules/@anishbenji/tscache/dist/` (the worker and the chunks beside it) from your origin and pass
`/vendor/tscache/worker.js`, as above.

### Checking the setup

`client.mode` is `'shared'`, or `'dedicated'` where SharedWorker is missing, when the URL resolved. An
unexpected `'in-process'` means both workers failed: listen for `modeFallback` during development to
see why.

## Stale scripts after a deploy

The worker reports its protocol version on connect, and the client refuses a mismatch with
`ProtocolMismatchError`. This catches a stale worker script, cached or kept alive by a tab opened before
an upgrade. Reloading the page fixes it once the old tabs are closed and the old worker has stopped: in
Chromium a SharedWorker lingers about 30 seconds after its last tab, so a reload within that window can still
reach it.

If your worker is served at a fixed URL (no content hash in the file name), the first upgrade to a release
that creates the SharedWorker with `extendedLifetime` (persistence slice (c)) also changes the worker's
creation options. A browser refuses to connect a tab to a running SharedWorker created with different
options, so tabs opened after that upgrade fall back to a dedicated worker (`modeFallback`) until the tabs
from before it are closed. Bundlers that hash worker file names give each release its own URL and avoid this.

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
