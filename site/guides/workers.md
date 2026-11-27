# Workers and fallback

## The hosting chain

The engine runs in one of three hostings, tried in order from `mode` (default `'shared'`):

1. **`'shared'`**: a `SharedWorker`. Every same-origin tab connects to the same worker, so they read
   one cache and share every fetch. This is the point of tscache.
2. **`'dedicated'`**: a `Worker` per tab. Each tab has its own cache; the work still runs off the main
   thread.
3. **`'in-process'`**: an engine in the page itself, behind the same message protocol. No sharing.

A `memoryBudget` ([Memory](/guides/patterns#memory)) bounds one engine: in a SharedWorker the caches of
every tab of that worker together, in a dedicated worker or in-process one tab's. While tabs of two
deploys run two SharedWorkers ([Stale scripts after a deploy](#stale-scripts-after-a-deploy)), each
worker has a budget of its own.

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
`createClient` pending: tscache 0.2.0 has no timeout on it ([Writing a fetcher](/guides/fetcher)).

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
worker file by that URL, so a query added to it would load the worker twice. This repository's
benchmarks and tests add a query on purpose, for a fresh SharedWorker per run (there is one per script
URL), and can because nothing there loads the persistence chunk from a Vite-built worker: the Vite-built
benchmark persists no cache and never calls `clearAll`, and the other suites load the package's own
build, whose chunks never import the worker file. A test of your own that persists a cache in a
Vite-built worker under such a query loads the worker twice.

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

A deploy reaches the tabs that are already open one at a time, so for a while tabs of two deploys run
side by side. From 0.3.0, tscache gives every deploy that changes what the worker runs a worker of its
own, tells the tabs of the older one, and leaves the origin's database with one writer.

### One SharedWorker per generation

A browser finds a SharedWorker by its URL and its name. tscache names its worker with the page's
**generation key**: the tscache version and the fetcher module URL, exactly as you pass it in
`fetcher.module`. The worker URL names the worker's build, so the URL and the key between them say what
a worker runs:

- Tabs that agree on the worker URL, the tscache version and the fetcher URL share one worker. A deploy
  that changes only application code changes none of the three, and its tabs join the running worker,
  as before.
- A deploy that changes the fetcher's URL, the tscache version or the worker URL starts a worker of
  its own. Its tabs are never refused by the old worker and never run the old worker's code. A worker
  rebuilt behind a fixed URL, with the tscache version and the fetcher URL unchanged, is joined as it
  runs: new tabs use the running worker's code until it ends. Until
  0.2.0 a deploy that changed only the fetcher was refused with `ConfigError` in every new tab until
  the old tabs had closed, and at a fixed worker URL new tabs ran against the old worker's code.

Three rules follow for your setup:

- **Give the fetcher a URL that changes with its contents.** Vite's `?fetcher` import does, with a
  content hash; so does a versioned path, or a query such as `fetcher.js?v=3`. The key sees the URL, not
  the file: a fetcher rebuilt behind an unchanged URL joins the running worker, which keeps the module
  it loaded until it stops. Revalidation updates the file, not a module a worker has already imported.
- **Pass the same `fetcher.module` string on every page.** Pages that name one module by two strings
  (`./fetcher.js` and `/fetcher.js`), or a page without a fetcher beside pages with one, get a worker
  each. Those workers share no cache and both persist, and no tab is told, since a reload would not
  join them. A development build of the worker warns in the worker's console.
- **Hashed or fixed, the worker URL works either way.** A hashed worker URL (the default with Vite and
  most bundlers) changes only when the worker bundle does, not when the fetcher does: Vite's `?fetcher`
  import emits the fetcher as a chunk of the page's build
  ([`fetcher-url.ts`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/vite/fetcher-url.ts)),
  and the worker bundle names no fetcher. The key carries the fetcher for that reason, and the tscache
  version for a worker served at a fixed URL.

Cache configs and `memoryBudget` are not in the key. A cache opened with another structure is still
refused with `ConfigError`, and another budget is ignored until the worker restarts
([Memory](/guides/patterns#memory)).

### Older tabs are told: `superseded`

The SharedWorkers of an origin find each other over a `BroadcastChannel`. Of two workers of different
generations, the one with the higher tscache version is current; for one version, the one that started
later. The other is **superseded**, for as long as it runs:

- Its tabs hear the `superseded` event, with the newer worker's tscache version as `lib`, and
  `client.superseded` holds that payload from then on, for code that runs later. When a tab connects
  to a worker already superseded and the event reaches it during start-up, the property is set when
  `createClient` resolves and the event follows on the next macrotask or with the worker's next
  message, whichever comes first: attach the listener right after `await createClient()`, and it is
  called. An event still on its way then (the worker was superseded, but its message had not reached
  the tab) arrives live and sets the property when it does.
- It stops persisting. Each persisted cache reports `persistStopped` with `reason: 'superseded'`, and
  nothing is deleted: the records belong to the newer worker now. How its removals and `clearAll()`
  answer then is under [Persistence](/guides/persistence#failures).
- Everything else goes on. The tab reads and writes its worker's memory and fetches through its own
  fetcher. A view there is no longer told of changes made through the newer deploy's tabs, which use
  another worker. A reload joins the newer worker.

Only the superseded worker's tabs are told; the current ones have nothing to do. Tell the user, and let
them reload:

<<< @/snippets/client.ts#superseded{ts}

tscache never reloads a page: it may hold unsaved state. Be careful with an automatic reload of your
own, for two reasons. A page served stale (an HTTP cache, a service worker's old shell) that starts
later than the current one ranks newer within one tscache version, so the current tabs would be told
to reload into the stale build. And after a rollback of tscache, the rolled-back worker ranks below the
release it replaced, so its tabs are told to reload into the same build until the newer tabs have
closed. A prompt shown once costs little in either case; a loop of reloads does not.

A superseded worker stays superseded: when the newer tabs close first, an old tab left open persists
nothing until it is reloaded.

`client.features.has('superseded')` says whether a tab can be told at all. It is true behind a
SharedWorker, and false behind a dedicated worker, an in-process client and a worker script from before
0.3.0. Where it is false, `client.superseded` stays `undefined` for good, which means "not known", not
"current"; a `superseded` listener there is simply never called, and no warning is printed for it.

### One tscache application per origin

The workers' channel belongs to the origin, as the `tscache` database does, and a worker on it cannot
tell another application from another deploy of its own. Two applications under one origin (say
`/charts/` and `/admin/`), each with its own worker script or fetcher, are two generations to tscache:
the one that started earlier is superseded and stops persisting, its tabs are told to reload, and the
reload starts a worker that supersedes the other application in turn. A `clearAll` in one clears the
other, and both would write one database.

Host one tscache application per origin. Serve a second application from an origin of its own (another
subdomain), or build the two as one: the same tscache version, worker script URL and fetcher module on
every page.

### What takes no part

- A worker of tscache 0.1.0 or 0.2.0 has no name and does not listen. Beside a worker of a later release
  it keeps writing the database until its tabs have closed, a `clearAll` does not reach it, and its
  tabs are told nothing: the first upgrade from those releases behaves as they did.
- A dedicated worker and an in-process client serve one tab each. They are never superseded and never
  told; their `clearAll` still reaches every SharedWorker of 0.3.0 or later, within the limits in
  [Sensitive data and logout](/guides/persistence#sensitive-data-and-logout).
- A browser without `BroadcastChannel` in workers detects nothing. Every browser with `SharedWorker` has
  it.

### A stale worker script

With named workers, a running worker of an older deploy no longer makes `createClient` reject: the
newer tab starts a worker of its own. What is left is a worker **script** that is not the page's build:
one served from an old HTTP cache entry, or one replaced at a fixed URL under a page that is still open.

- When its protocol version differs, `createClient` rejects with `ProtocolMismatchError`, whose message
  names both versions (`worker speaks protocol 1, client speaks 2`, or the reverse when the worker
  refuses) and whose `clientProtocol` and `workerProtocol` fields hold them. It never steps down: a
  dedicated worker would load the same stale script. Reload the page with the HTTP cache revalidated,
  and serve the worker script with revalidation (`Cache-Control: no-cache`) or under a hashed URL.
- When only its tscache version differs, the client connects, and a development build warns once,
  naming both versions.

The refusal of a second fetcher module still exists, for a connection that arrives without the name:
a page of 0.2.0 that loads a later release's worker script at a fixed URL. It is a `ConfigError`.
Clients from 0.3.0 set its `code` to `'fetcher-conflict'`; recognise it by that code, not by its
message, since every other `ConfigError` has no `code`. A 0.2.0 page, the one that meets it now, sees
the same `ConfigError` with the message only.

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
