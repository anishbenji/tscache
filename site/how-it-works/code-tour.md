# Code tour

This page reads the source of `packages/tscache/src/` in the order a request travels: from the package
entries, through the client in the page and the RPC layer, into the worker, where the orchestrator
plans fetches in front of the engine, down to the segments and the coverage index, out to IndexedDB,
and finally to the Vite plugin that serves the fetcher module at build time.

Each stop lists the symbols to open, as `path#symbol` (`A.b` is the member `b` of `A`), says what to
notice in them, and names a scenario of the [demo hub](/guide/demo) (`bun run demo`) where the code is
at work. `bun run docs:check` fails when an anchor on this page stops resolving.

## 1. The entries

Read:

- [`packages/tscache/src/entries/index.ts#createClient`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/entries/index.ts)
- [`packages/tscache/src/entries/worker.ts#createServer`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/entries/worker.ts)
- [`packages/tscache/src/entries/engine.ts#Engine`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/entries/engine.ts)
- [`packages/tscache/src/entries/fetcher.ts#AuthInvalidError`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/entries/fetcher.ts)
- [`packages/tscache/src/entries/vite.ts#fetcherUrl`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/entries/vite.ts)

What to notice:

- Four of the five entries only re-export. `entries/worker.ts` is the one that runs code when it loads:
  it builds the worker's server and attaches it (stop 4).
- `.` re-exports `createClient`, the errors, `encodeSnapshot` and `decodeSnapshot`, `DTYPES` and types;
  the `CacheHandle` and `TscacheClient` are exported as types only. `./engine` exports the `Engine`
  class itself, for server code and tests.
- `./fetcher` re-exports from `errors.ts` alone, plus type-only exports of the fetcher types.
- [Package map](./package-map) shows what each entry's imports reach.

In the demo hub: every example page imports the worker entry as a URL
(`@anishbenji/tscache/worker?worker&url`) and passes it to `createClient` as `workerUrl`; for instance
**Two tabs, one SharedWorker** (`examples/react-lwcharts/src/client.ts`).

## 2. The client

Read:

- [`packages/tscache/src/client/client.ts#createClient`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/client/client.ts)
- [`packages/tscache/src/client/client.ts#CHAIN`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/client/client.ts)
- [`packages/tscache/src/client/client.ts#connect`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/client/client.ts)
- [`packages/tscache/src/client/client.ts#Client`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/client/client.ts)
- [`packages/tscache/src/client/client.ts#Client.#lose`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/client/client.ts)
- [`packages/tscache/src/client/hosting.ts#handshake`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/client/hosting.ts)
- [`packages/tscache/src/client/hosting.ts#openShared`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/client/hosting.ts)
- [`packages/tscache/src/client/hosting.ts#openDedicated`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/client/hosting.ts)
- [`packages/tscache/src/client/hosting.ts#openInProcess`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/client/hosting.ts)
- [`packages/tscache/src/client/cache.ts#CacheHandle`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/client/cache.ts)
- [`packages/tscache/src/client/events.ts#ClientEmitter`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/client/events.ts)

What to notice:

- `createClient` validates its options before it creates anything: `workerUrl` is required unless the
  chain starts at `'in-process'`, and `handshakeTimeoutMs` (default 5000) must be a positive number.
- `connect` walks `CHAIN` from `options.mode`. Only a `HostingError` steps down to the next hosting;
  any other error, a `ProtocolMismatchError` included, rejects `createClient`. Each step is kept and
  emitted as `modeFallback` on the next macrotask, once the caller has had a chance to subscribe.
- `handshake` arms its timer only until `hello` arrives; loading the fetcher module, which happens
  before `init-ok`, has no timeout. A worker `error` event before then aborts the handshake.
- `openShared` creates the SharedWorker with `type: 'module'` and `extendedLifetime: true`, and on
  `hello` queues on the worker's lifetime lock. A grant before `init-ok` fails the hosting; a grant
  afterwards aborts the connected port client, which `Client.#lose` turns into one `workerLost` event.
  `openDedicated` learns of its worker's failure from the worker's `error` event instead.
- `openInProcess` loads `client/in-process.ts` with `import()`, so a page served by a worker never
  downloads the engine; a chunk that fails to load is a `HostingError`.
- `CacheHandle` sends one request per method with its cache id filled in. `put` transfers the batch's
  buffers, so the caller's arrays are detached afterwards; `hydrate` sends its snapshot without a
  transfer list, so the snapshot stays usable.
- `Client` disposes itself on the page's `pagehide`, unless the page enters the back/forward cache
  (`persisted`), because the worker would otherwise never learn that the tab went.
- `ClientEmitter.receive` maps wire events onto `ClientEvents` and ignores names it does not know.

In the demo hub: **Two tabs, one SharedWorker**: crash the tab that opened first (it hosts the
SharedWorker): the other tabs get `workerLost` and build a new client. The server-rendered entries
(**Server-rendered candles**, **Server-rendered sensor**) create their server-side client with
`mode: 'in-process'`.

## 3. The RPC layer

Read:

- [`packages/tscache/src/rpc/protocol.ts#Hello`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/rpc/protocol.ts)
- [`packages/tscache/src/rpc/protocol.ts#Evt`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/rpc/protocol.ts)
- [`packages/tscache/src/rpc/protocol.ts#toWireError`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/rpc/protocol.ts)
- [`packages/tscache/src/rpc/protocol.ts#fromWireError`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/rpc/protocol.ts)
- [`packages/tscache/src/rpc/protocol.ts#transferablesOf`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/rpc/protocol.ts)
- [`packages/tscache/src/rpc/port-client.ts#PortClient.connect`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/rpc/port-client.ts)
- [`packages/tscache/src/rpc/port-client.ts#PortClient.request`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/rpc/port-client.ts)
- [`packages/tscache/src/rpc/server.ts#RpcServer.attach`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/rpc/server.ts)
- [`packages/tscache/src/rpc/server.ts#RpcServer.#init`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/rpc/server.ts)
- [`packages/tscache/src/rpc/server.ts#RpcServer.#handlers`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/rpc/server.ts)
- [`packages/tscache/src/rpc/server.ts#RpcServer.#request`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/rpc/server.ts)
- [`packages/tscache/src/rpc/server.ts#Persistence`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/rpc/server.ts)
- [`packages/tscache/src/rpc/lifetime.ts#holdLifetimeLock`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/rpc/lifetime.ts)
- [`packages/tscache/src/rpc/lifetime.ts#watchLifetimeLock`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/rpc/lifetime.ts)

What to notice:

- The server speaks first. `RpcServer.attach` gives each port a client id (`c1`, `c2`, …) and posts
  `hello` with the protocol, the library version and, in a SharedWorker, the lifetime lock's name.
  The client answers `init`, which carries the fetcher config.
- `RpcServer.#init` refuses another protocol with `init-err`, then loads the fetcher module before it
  answers `init-ok`, so a module that fails to load rejects `createClient` at startup.
- Every request is `{ t: 'req', id, op, params }`, with `id` counted per port client. The server names
  a request `clientId:id`, the request id that request-scoped events carry.
- `RpcServer.#handlers` sends `get`, `invalidate` and `updateAuth` to the orchestrator and `put`,
  `clear`, `setFinalizedUntil` and `hydrate` to the engine. When the hosting has a persistence, every
  op that names a cache runs through `Persistence.durably`, `clearAll` goes to `Persistence.clearAll`,
  and `cache` of a cache with `persist: true` answers only once `Persistence.open` has settled.
- `RpcServer.#request` transfers a `get` result's buffers (`transferablesOf`) instead of copying them,
  and answers a `dispose` before it drops the port.
- Errors cross the port as plain `WireError` objects. `toWireError` names an error by its class, found
  with `instanceof`, because a minifier may rename the constructor; `fromWireError` rebuilds the class
  and turns an unknown name into a `TscacheError`.
- Events fan out to every ready port. A port the server drops on its own initiative gets a `bye` first,
  because a browser `MessagePort` fires no close event; when the last connection goes, the server
  flushes persistence.
- `holdLifetimeLock` takes an exclusive Web Lock that is never released while the worker runs, and
  `watchLifetimeLock` queues on it in shared mode: the grant means the holder is gone.

In the demo hub: **Two tabs, one SharedWorker**, or any reference client: every tab is one port of
the same server, so a second tab draws from what the first one fetched.

## 4. The worker host

Read:

- [`packages/tscache/src/entries/worker.ts#createServer`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/entries/worker.ts)
- [`packages/tscache/src/entries/worker.ts#dedicatedWorkerScope`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/entries/worker.ts)
- [`packages/tscache/src/entries/worker.ts#sharedWorkerScope`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/entries/worker.ts)
- [`packages/tscache/src/entries/worker.ts#lazyPersist`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/entries/worker.ts)
- [`packages/tscache/src/client/in-process.ts#connectInProcess`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/client/in-process.ts)
- [`packages/tscache/src/persist/clear-only.ts#lazyIdbStore`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/persist/clear-only.ts)

What to notice:

- The entry tells the two worker kinds apart by their globals: both have `importScripts`, and only a
  SharedWorker's global has `onconnect`.
- In a dedicated worker, the global scope itself is the port: one server is attached to it at load.
- In a SharedWorker, the `connect` listener goes on at load, so no connection is missed, but ports wait
  until the worker holds its lifetime lock; every `hello` can then name the lock. One server serves
  every port.
- `createServer` builds one `Engine` and one `RpcServer` around it, and chooses the persistence: in the
  SharedWorker a `HostedPersistence`, in the dedicated worker a `ClearOnlyPersistence`, and none where
  `lazyIdbStore` finds no IndexedDB.
- `connectInProcess` builds the same pair, an `Engine` and an `RpcServer`, in the page, and connects to
  it over a `MessageChannel`: the in-process hosting runs the same protocol as the workers.

In the demo hub: **Two tabs, one SharedWorker**: every tab you open reads mode `shared`, and a new tab
draws three days at once and fetches only the forming bar.

## 5. The orchestrator

Read:

- [`packages/tscache/src/orchestrator/orchestrator.ts#Orchestrator.get`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/orchestrator/orchestrator.ts)
- [`packages/tscache/src/orchestrator/orchestrator.ts#Orchestrator.#rounds`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/orchestrator/orchestrator.ts)
- [`packages/tscache/src/orchestrator/orchestrator.ts#Orchestrator.#round`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/orchestrator/orchestrator.ts)
- [`packages/tscache/src/orchestrator/orchestrator.ts#planRound`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/orchestrator/orchestrator.ts)
- [`packages/tscache/src/orchestrator/orchestrator.ts#coalesce`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/orchestrator/orchestrator.ts)
- [`packages/tscache/src/orchestrator/orchestrator.ts#Orchestrator.#run`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/orchestrator/orchestrator.ts)
- [`packages/tscache/src/orchestrator/orchestrator.ts#Orchestrator.#apply`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/orchestrator/orchestrator.ts)
- [`packages/tscache/src/orchestrator/orchestrator.ts#Orchestrator.#refused`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/orchestrator/orchestrator.ts)
- [`packages/tscache/src/orchestrator/orchestrator.ts#Orchestrator.invalidate`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/orchestrator/orchestrator.ts)
- [`packages/tscache/src/orchestrator/orchestrator.ts#Orchestrator.load`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/orchestrator/orchestrator.ts)
- [`packages/tscache/src/orchestrator/orchestrator.ts#Orchestrator.updateAuth`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/orchestrator/orchestrator.ts)
- [`packages/tscache/src/orchestrator/orchestrator.ts#annotate`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/orchestrator/orchestrator.ts)
- [`packages/tscache/src/orchestrator/auth.ts#AuthState`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/orchestrator/auth.ts)

What to notice:

- Without a fetcher, or with `cacheOnly: true`, `Orchestrator.get` is one `Engine.get`.
- Otherwise a round, `Orchestrator.#round`, runs in one synchronous step from reading the coverage to
  listing its new fetches, so two rounds never interleave, whichever tabs they serve. It reads the
  coverage one slot beyond the request at each end, so a miss at the edge can extend into it.
- `planRound` takes the request's slots that are neither covered nor blocked, joins the fetches in
  flight that meet them, and fetches only the rest. `coalesce` merges adjacent misses and extends a
  miss by one slot into coverage next to it.
- A fetch in flight can be joined only while its cache generation (cleared count) and auth generation
  are current and no `invalidate` has fenced it.
- `Orchestrator.#run` passes the fetcher copies of the range and a clone of the auth context. Once the
  fetcher settles, the outcome is decided in one step: a response that started before a clear of the
  cache is dropped, any other is applied by `Orchestrator.#apply` as a put with the fetched range as
  its authority, and the fetch leaves the in-flight list in that same step.
- `Orchestrator.#rounds` runs a second round only when the cache was cleared while the first waited,
  minus the ranges whose fetch failed or came back auth-pending; then it reads the engine once.
  `annotate` relabels the misses those fetches leave as `'fetch-failed'` or `'auth-pending'`.
- `Orchestrator.#refused` recognises an expired credential with `isAuthInvalidError`, and only a
  failure under the current auth generation flips `AuthState`, which broadcasts `authInvalid` once per
  flip. While auth is invalid, or while `updateAuth` is swapping credentials, a round fetches and joins
  nothing and its misses come back `'auth-pending'` at once.
- `Orchestrator.updateAuth` applies updates one at a time: the fetcher's `updateAuth` hook hears a
  clone of the new context, then the context and the auth generation switch together.
- `Orchestrator.load` imports the fetcher module once per server, so once per SharedWorker. A connection naming another module
  gets a `ConfigError`; one bringing a different context goes through `updateAuth`.

In the demo hub: **Candles with weekend gaps**: load an earlier fortnight; the page asks for the whole
range and only the new fortnight is fetched. **Two tabs, one SharedWorker**: expire the access token;
one tab refreshes it, the others carry on, and the backend counts one refresh.

## 6. The engine

Read:

- [`packages/tscache/src/engine/engine.ts#Engine.cache`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/engine/engine.ts)
- [`packages/tscache/src/engine/engine.ts#STRUCTURAL`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/engine/engine.ts)
- [`packages/tscache/src/engine/engine.ts#Engine.clearAll`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/engine/engine.ts)
- [`packages/tscache/src/engine/validate.ts#resolveCacheConfig`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/engine/validate.ts)
- [`packages/tscache/src/engine/cache.ts#CacheState.put`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/engine/cache.ts)
- [`packages/tscache/src/engine/cache.ts#CacheState.#putValid`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/engine/cache.ts)
- [`packages/tscache/src/engine/cache.ts#CacheState.#applyVersion`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/engine/cache.ts)
- [`packages/tscache/src/engine/cache.ts#CacheState.#setWatermark`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/engine/cache.ts)
- [`packages/tscache/src/engine/cache.ts#CacheState.hydrate`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/engine/cache.ts)
- [`packages/tscache/src/engine/batch.ts#validateBatch`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/engine/batch.ts)
- [`packages/tscache/src/engine/read.ts#read`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/engine/read.ts)

What to notice:

- `Engine.cache` is get-or-create. A second config for the same id must agree on every field in
  `STRUCTURAL`, or it throws `ConfigError`; its version and `finalizedUntil` are ignored.
- The engine is synchronous and has no timers: every method runs to completion inside the call, and
  `Engine.clearAll` empties every cache but keeps the caches and their configs.
- `CacheState.put` validates the whole batch before it changes anything (`validateBatch`: alignment,
  strictly ascending timestamps, field lengths, the put's range), copying the values into fresh arrays
  of the schema's dtypes.
- `CacheState.#putValid` then runs in a fixed order: a differing version clears the cache
  (`CacheState.#applyVersion`); the points are written; the watermark advances; the put's claim,
  minus the provisional slots, is recorded as coverage; and only then is the version clear reported.
- `CacheState.#setWatermark` withdraws coverage from the new watermark slot on whenever the
  provisional region grows, so those points are fetched again.
- `CacheState.hydrate` writes a snapshot only into the parts of its coverage this cache neither covers
  nor holds as provisional, and refuses a snapshot of another dataset version.
- `read` returns every present point in the request with the covered sub-ranges and the uncovered
  ones as `'uncached'` misses; this is where slots become milliseconds again.
- [Data model](./data-model) draws the state these calls change.

In the demo hub: **Live server metrics and sparse events**: the log shows one ten-minute fetch, then
short fetches of the provisional tail only; **Restate history** makes the backend answer with a new
dataset version, and the cache clears itself and fetches the window again.

## 7. Segments and coverage

Read:

- [`packages/tscache/src/grid.ts#snapOut`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/grid.ts)
- [`packages/tscache/src/grid.ts#snapIn`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/grid.ts)
- [`packages/tscache/src/engine/merge.ts#SegmentStore.put`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/engine/merge.ts)
- [`packages/tscache/src/engine/merge.ts#SegmentStore.#together`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/engine/merge.ts)
- [`packages/tscache/src/engine/merge.ts#SegmentStore.#carve`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/engine/merge.ts)
- [`packages/tscache/src/segment/dense.ts#DenseSegment`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/segment/dense.ts)
- [`packages/tscache/src/segment/dense.ts#DenseSegment.mergeFrom`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/segment/dense.ts)
- [`packages/tscache/src/segment/types.ts#Segment`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/segment/types.ts)
- [`packages/tscache/src/coverage.ts#CoverageIndex.add`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/coverage.ts)
- [`packages/tscache/src/coverage.ts#CoverageIndex.subtract`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/coverage.ts)
- [`packages/tscache/src/coverage.ts#CoverageIndex.gaps`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/coverage.ts)

What to notice:

- `grid.ts` is the only module that converts between milliseconds and slots; everything below it does
  range arithmetic on integer slots. A read or an invalidation snaps outward (`snapOut`), a put's
  authority inward (`snapIn`).
- `SegmentStore.put` first removes the stored points inside the put's authority
  (`SegmentStore.#carve`), then writes the batch one run at a time. `SegmentStore.#together` is the
  layout rule: two points share a segment when they lie on the same page and at most `gapSplitK` slots
  between them hold no point.
- A `DenseSegment` stores no timestamps: a slot's time follows from its position. It keeps one typed
  array per field and one presence bit per slot, so a point has all of its fields or none.
- `DenseSegment.mergeFrom` with an authority leaves exactly the given points inside it; without one it
  only adds or overwrites.
- `CoverageIndex.add` merges overlapping and adjacent ranges; `CoverageIndex.subtract` may split one
  range in two; `CoverageIndex.gaps` gives the uncovered sub-ranges that become a read's misses.

In the demo hub: **Greenhouse sensor with dropouts**: the three charts break at exactly the same
places, because presence is per point. **Live server metrics and sparse events**, events page:
zooming inside the loaded week asks the backend for nothing, because empty slots are covered, not
missing.

## 8. Persistence

Read:

- [`packages/tscache/src/persist/hosted.ts#HostedPersistence`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/persist/hosted.ts)
- [`packages/tscache/src/persist/clear-only.ts#ClearOnlyPersistence`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/persist/clear-only.ts)
- [`packages/tscache/src/persist/lazy.ts#Persister`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/persist/lazy.ts)
- [`packages/tscache/src/persist/persister.ts#Persister.open`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/persist/persister.ts)
- [`packages/tscache/src/persist/persister.ts#Persister.#plan`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/persist/persister.ts)
- [`packages/tscache/src/persist/persister.ts#Persister.#rejected`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/persist/persister.ts)
- [`packages/tscache/src/persist/persister.ts#durably`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/persist/persister.ts)
- [`packages/tscache/src/persist/records.ts#PageRecord`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/persist/records.ts)
- [`packages/tscache/src/persist/idb-store.ts#openIdbStore`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/persist/idb-store.ts)
- [`packages/tscache/src/engine/cache.ts#installRestore`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/engine/cache.ts)

What to notice:

- `persist/` imports the engine; the engine imports nothing from `persist/`. The persister reaches a
  cache's state through internal functions that no package entry exports, and installs `restore`'s
  implementation with `installRestore` when it is constructed.
- `HostedPersistence` loads `persist/lazy.ts`, the persister and the IndexedDB adapter, with
  `import()` at the first persisted cache or the first `clearAll`. Calls that arrive meanwhile wait
  and reach the persister in arrival order. A chunk that fails to load, or does not load in time,
  turns persistence off for the worker's life.
- `Persister.open` loads a cache's records under one deadline (`timeoutMs`, default 5000 ms). Writes
  are behind: a flush is due `debounceMs` (1000) after the latest change and no later than
  `maxDelayMs` (5000) after the first, and is planned from memory alone (`Persister.#plan`) without
  reading the disk.
- `durably` holds an op's answer until a removal it, or another op meanwhile, recorded is on disk or
  the cache's persistence has stopped, so an `invalidate` or a `clear` is not answered while the disk
  still holds what it removed.
- A `QuotaExceededError` stops the cache's persistence at once rather than retrying
  (`Persister.#rejected`); the stop reaches every tab as `persistStopped`.
- `openIdbStore` opens one database per origin, `tscache` at version 1, with a `caches` and a `pages`
  object store; a `PageRecord` holds a snapshot of one page's covered ranges.
- `ClearOnlyPersistence`, in the dedicated-worker and in-process hostings, persists nothing; its
  `clearAll` empties the database too.

In the demo hub: no scenario persists a cache. Every example app and reference client builds its
worker with `worker: { format: 'es' }` (for instance `examples/vanilla-uplot/vite.config.ts`), so this
chunk stays a file of its own, which a worker loads only at its first persisted cache or its first
`clearAll`. [Persistence](/guides/persistence) shows how to turn it on.

## 9. The Vite plugin

Read:

- [`packages/tscache/src/vite/fetcher-url.ts#fetcherUrl`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/vite/fetcher-url.ts)
- [`packages/tscache/src/vite/fetcher-url.ts#IIFE_WARNING`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/vite/fetcher-url.ts)
- [`packages/tscache/src/vite/urls.ts#devUrl`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/vite/urls.ts)
- [`packages/tscache/src/vite/urls.ts#serverFileUrl`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/vite/urls.ts)

What to notice:

- The worker loads the fetcher with `import()` and needs its default export. Vite would bundle a
  `?worker&url` import without its exports, so `import url from "./fetcher.ts?fetcher"` resolves
  instead to a module whose default export is the fetcher's URL.
- In a build, the plugin's `load` hook emits the fetcher as a chunk of its own with its signature
  preserved (`preserveSignature: 'strict'`). In dev it serves the file from source: the browser gets an
  `@fs` URL under the base (`devUrl`), server code the file's absolute path. In a server build the URL
  is a file URL built at run time (`serverFileUrl`).
- `generateBundle` fails the build when the fetcher's chunk, or any chunk it reaches, contains Vite's
  module-preload helper, which needs `document` and `window`, which a worker does not have.
- `buildStart` warns once when a browser build makes workers as IIFE, which cannot split off the
  worker's persistence chunk; the plugin never changes the format.
- The plugin imports nothing from Vite, not even its types: it declares the shapes of the context it
  uses.

In the demo hub: every example app and reference client lists `fetcherUrl()` in its `vite.config.ts`
and imports its fetcher with `?fetcher`; for instance **Two tabs, one SharedWorker**
(`examples/react-lwcharts/src/client.ts`).
