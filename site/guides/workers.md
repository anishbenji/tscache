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

The copied worker files are served as they are. The library's own code is still bundled into your
application, and that includes the in-process hosting, which loads the fetcher module with a runtime
`import()` of the URL you pass. The import carries `/* webpackIgnore: true */` and
`/* @vite-ignore */`, so the bundler leaves it for the runtime instead of replacing it with a stub that
always rejects. A probe on 2026-11-10, run by hand against a copy of the built package with the hint
added, checked this with webpack 5.112.2, Rspack 2.3.2 and Next.js 16.4.6 with Turbopack.
The repository's own tests build with Vite only.

### No bundler

Serve `node_modules/@anishbenji/tscache/dist/` (the worker and the chunks beside it) from your origin and pass
`/vendor/tscache/worker.js`, as above.

### Checking the setup

`client.mode` is `'shared'`, or `'dedicated'` where SharedWorker is missing, when the URL resolved. An
unexpected `'in-process'` means both workers failed: listen for `modeFallback` during development to
see why.

## Stale scripts after a deploy

The worker reports its protocol version on connect, and the client refuses a mismatch with
`ProtocolMismatchError`, whose message names both versions (`worker speaks protocol 1, client speaks 2`,
or the reverse when the worker refuses) and whose `clientProtocol` and `workerProtocol` fields hold them.
This catches a stale worker script, cached or kept alive by a tab opened before an upgrade. Reloading the
page fixes it once the old tabs are closed and the old worker has stopped: in Chromium a SharedWorker
lingers about 30 seconds after its last tab, so a reload within that window can still reach it.

::: warning Known limit: deploy skew has no recovery path
tscache 0.1.0 detects skew only when the worker refuses a connection, for a protocol mismatch or a
second fetcher module, and offers nothing beyond the error: no retry, and no event that tells an old tab
a newer worker exists. An application cannot close a user's other tabs. What happens depends on how the
worker is served, and on what the deploy changed.

A hashed worker URL (the default with Vite and most bundlers) changes when the worker bundle changes: a
new tscache version, another worker format, or different output from the build tool. It does not change
when only the fetcher does. The worker bundle names no fetcher: Vite's `?fetcher` import emits the
fetcher as a chunk of the page's build
([`fetcher-url.ts`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/vite/fetcher-url.ts)),
and the client sends its URL to the worker when it connects. Built twice with Vite 8.3.5, once with a
changed fetcher, an example app got a new fetcher file name and a worker file identical byte for byte.

- **A hashed worker URL, and a deploy that changes the worker,** gives that deploy a SharedWorker of its
  own. There is no protocol mismatch then, and nothing reports the skew. Tabs of the old deploy and
  of the new one stop sharing the cache's memory, fetches in flight, `clear`, `clearAll` and
  `authInvalid` until the old tabs close, which for a tab left open may be days. For persisted caches
  both workers write the one IndexedDB database of the origin ([Persistence](/guides/persistence)).
  Every record is checked on its own when it is loaded, but one worker can delete pages the other
  stored, which then read as uncached and are fetched again, and it can write back a range the other
  removed with `invalidate` or `clear` while it still holds that range. A dataset whose restatements
  change its `version` is not exposed to that, since records of another version are never loaded. A
  logout's `clearAll` in a new tab empties the disk and its own worker, but the old worker writes back
  the pages it still holds ([Sensitive data and logout](/guides/persistence#sensitive-data-and-logout)).
- **A hashed worker URL, and a deploy that changes only the fetcher,** keeps the worker URL, so a new
  tab joins the old SharedWorker. That worker already runs the old fetcher module, and a worker runs
  one: `createClient` in the new tab rejects with a `ConfigError`
  (`this worker already runs fetcher <old URL>; cannot also load <new URL>`) and does not fall back.
  Every new tab fails this way until the old tabs close and the old worker has stopped.
- **A fixed worker URL** makes every tab of every deploy join one SharedWorker, so the origin keeps a
  single writer. New tabs then run against the old worker's code until the old tabs close: the worker
  reports its package version on connect, but the client does not check it, so a release that keeps the
  protocol connects silently. A release that changes the protocol is refused with
  `ProtocolMismatchError`. A new fetcher module URL is refused with the `ConfigError` above.
  Vite's `?fetcher` import gives the module a hashed name, so a fixed worker URL needs a fetcher built
  on its own at a fixed name too
  ([A fetcher that needs `import()`](/guides/vite#a-fetcher-that-needs-import) shows the build). Serve
  both files with revalidation.

What a page can do with a `ProtocolMismatchError` depends on which side is stale. A dedicated worker
loads the script at the same URL, so `mode: 'dedicated'` helps only when the stale side is a running
SharedWorker that old tabs keep alive: the page is then newer (the error's `clientProtocol` is larger
than its `workerProtocol`), and creating the client again with `mode: 'dedicated'` gives that tab a
cache of its own, shared with no other tab and persisting nothing, until it is reloaded after the old
tabs have closed. When the page itself is stale (an old tab that creates its client again after
`workerLost`, or HTML or script served from an old cache), or the worker script came from an old HTTP
cache entry, the dedicated worker is refused the same way, and the chain does not step down on this
error: the page has to reload.

The `ConfigError` for a second fetcher module allows the same step, again only when the page is the
newer side. Recognise it by its message, which starts with `this worker already runs fetcher`, not by
its class: the other `ConfigError`s of `createClient` report invalid options, and a retry on every
`ConfigError` would hide an invalid `mode` behind `'dedicated'`. A dedicated worker is a new worker that
loads the fetcher the page names, so for a page of the current deploy, creating the client again with
`mode: 'dedicated'` works until the tab is reloaded after the old tabs have closed. A stale page (an old
tab that creates its client again after `workerLost`, or HTML or script served from an old cache) meets
a worker that already runs the newer fetcher, and its retry loads the old one: it fails with the
fetcher-load `TscacheError` when the deploy removed that file, and otherwise runs the old fetcher without
any error. A page that may itself be stale has to reload. Nothing else separates the deploys' workers
today: tscache gives the SharedWorker no name a deploy id could go into, and a query added to a Vite
worker URL loads the worker twice ([Vite](#vite)). A recovery path is planned.
:::

## Losing the worker

Chromium runs a SharedWorker in the process of the tab that created it. If that tab crashes, the worker
and its cache go with it, and the other tabs get no `error` and no port closure. tscache detects it with
a Web Lock that the worker holds for its lifetime: every other tab's client then rejects its pending and
later calls with `TscacheError` and emits `workerLost` once. Create a new client to go on; it starts a
new worker, whose memory starts empty. A cache with `persist: true` restores what the old worker had
written to IndexedDB when you call `client.cache()` again in the new client ([Persistence](/guides/persistence));
every other cache starts empty.

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
