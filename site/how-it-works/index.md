# How it works

This section describes tscache from its source code. Each diagram lists the files and symbols it is drawn
from, as `path#symbol`, so you can check it against the code. Paths are relative to the repository
root.

- **Overview** (this page): the pieces of the system and where each one runs.
- [**Package map**](./package-map): the five package entries, and a module graph generated from the
  package's imports.
- [**Data model**](./data-model): the grid, slots, segments, coverage, versions and watermarks inside one
  cache.
- [**Code tour**](./code-tour): the source read in the order a request travels, from the entries to the
  Vite plugin, with the demo-hub scenario that shows each part at work.

The flows, each a sequence diagram with a walkthrough and the code behind it:

- [**Startup and fallback**](./startup): the hosting chain and the handshake.
- [**A read, end to end**](./read): `get()` from a tab to the worker and back, with in-flight
  subtraction and coalescing.
- [**Sharing across tabs**](./tabs): the first tab starts the SharedWorker, later tabs join, a tab
  closes, the worker dies.
- [**Fences and invalidation**](./fences): the clear generation and the invalidate fence.
- [**Auth refresh**](./auth): a refused token, the `authInvalid` broadcast, `updateAuth`, and the next
  read.
- [**Persistence**](./persistence): restore at `cache()`, write-back, and a quota stop.
- [**Live feeds**](./live-feeds): the reference clients' elected feed tab, which puts bars into the
  shared cache.

## The system

<figure class="hiw-figure">
<!--@include: ./overview.svg-->
</figure>

Every tab runs its own client. The client reaches one engine through a `MessagePort`: in a SharedWorker,
which every tab that loads the same worker script shares, or in a dedicated worker or the page itself
when a SharedWorker cannot start. Next to the engine, the orchestrator turns a read's misses into calls to your fetcher
module, which is the only part of tscache that talks to your backend. In the SharedWorker, the
persistence layer keeps the caches that ask for it in IndexedDB.

| Piece          | Runs in     | What it does                                                                                                                                                                 |
| -------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client         | each page   | `createClient` tries the hostings in turn and wraps the connected port; `client.cache(config)` returns a `CacheHandle`, whose data methods are each one request              |
| `PortClient`   | each page   | the page's end of the port: completes the handshake, matches each response to its request by id, rebuilds errors and passes events on                                        |
| `RpcServer`    | the hosting | one per engine, any number of ports: greets each port with a `hello` naming its client id, expects an `init` back, dispatches requests, and sends events to every ready port |
| `Orchestrator` | the hosting | serves `get` and `invalidate`: plans the fetches a read needs, minus those already in flight, calls the fetcher, applies each response as a put, then reads once             |
| `Engine`       | the hosting | the caches, by id; each `CacheState` holds its segments, coverage index, dataset version and watermark                                                                       |
| Persistence    | the hosting | in the SharedWorker, loads the persister on demand and keeps caches with `persist: true` in IndexedDB; in the other hostings, only empties the database at `clearAll`        |
| Fetcher module | the hosting | your module: its default export's `fetch` answers the orchestrator's requests; loaded once, with `import()`, during the handshake                                            |

Drawn from:

- [`packages/tscache/src/client/client.ts#createClient`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/client/client.ts)
- [`packages/tscache/src/client/cache.ts#CacheHandle`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/client/cache.ts)
- [`packages/tscache/src/rpc/port-client.ts#PortClient`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/rpc/port-client.ts)
- [`packages/tscache/src/rpc/server.ts#RpcServer`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/rpc/server.ts)
- [`packages/tscache/src/orchestrator/orchestrator.ts#Orchestrator`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/orchestrator/orchestrator.ts)
- [`packages/tscache/src/engine/engine.ts#Engine`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/engine/engine.ts)
- [`packages/tscache/src/engine/cache.ts#CacheState`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/engine/cache.ts)
- [`packages/tscache/src/segment/dense.ts#DenseSegment`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/segment/dense.ts)
- [`packages/tscache/src/coverage.ts#CoverageIndex`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/coverage.ts)
- [`packages/tscache/src/persist/hosted.ts#HostedPersistence`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/persist/hosted.ts)
- [`packages/tscache/src/persist/clear-only.ts#ClearOnlyPersistence`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/persist/clear-only.ts)
- [`packages/tscache/src/persist/persister.ts#Persister`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/persist/persister.ts)
- [`packages/tscache/src/persist/idb-store.ts#openIdbStore`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/persist/idb-store.ts)
- [`packages/tscache/src/types.ts#Fetcher`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/types.ts)

## The three hostings

`createClient` tries the hostings in a fixed order, `shared`, then `dedicated`, then `in-process`,
starting from `options.mode` (default `shared`). A hosting that cannot start throws a `HostingError`:
the client steps down to the next one and reports the step as a `modeFallback` event. Any other error,
such as a protocol mismatch, rejects `createClient`. `client.mode` tells which hosting won.

| Hosting      | Where the engine runs                                                                                                       | Persistence                                                   |
| ------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `shared`     | a SharedWorker, created with `type: 'module'` and `extendedLifetime: true`; one engine serves every tab that connects       | caches with `persist: true` are kept in IndexedDB             |
| `dedicated`  | a dedicated `Worker` per client; the worker's global scope is the port                                                      | none; where IndexedDB exists, `clearAll` empties the database |
| `in-process` | the page itself, over a `MessageChannel`; its code is a chunk the page loads with `import()` only when the chain reaches it | none; where IndexedDB exists, `clearAll` empties the database |

All three run the same server: each builds an `RpcServer` around a new `Engine`, and the server builds
its own `Orchestrator`. The fetcher module is therefore loaded wherever the engine runs, in the page
for the in-process hosting.

Where the browser has Web Locks (secure contexts only), the SharedWorker holds a lock for as long as it
runs and names it in its `hello` (`hello.lock`). A shared-mode client queues on that lock; it is granted
the lock only once the worker is gone. A dedicated worker's client learns of its worker's failure from
the worker's `error` event instead. Either way the client then rejects everything pending and emits
`workerLost`; only the detection differs.

The client queues on the lock as soon as `hello` names it, before the handshake ends. A grant that
arrives before `init-ok`, for example because the worker died while it loaded the fetcher module, fails
the shared hosting with a `HostingError`, and the client steps down the chain instead of emitting
`workerLost`. The handshake timeout (`handshakeTimeoutMs`) bounds only the wait for `hello`.

Without Web Locks, the SharedWorker names no lock and the client watches none. A worker that dies with
the tab hosting it (a renderer crash) is then noticed only if the browser fires a `close` event on the
port; where it does not, pending requests stay pending and no `workerLost` is emitted.

Drawn from:

- [`packages/tscache/src/client/client.ts#CHAIN`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/client/client.ts)
- [`packages/tscache/src/client/hosting.ts#HostingError`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/client/hosting.ts)
- [`packages/tscache/src/client/hosting.ts#openShared`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/client/hosting.ts)
- [`packages/tscache/src/client/hosting.ts#openDedicated`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/client/hosting.ts)
- [`packages/tscache/src/client/hosting.ts#openInProcess`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/client/hosting.ts)
- [`packages/tscache/src/client/in-process.ts#connectInProcess`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/client/in-process.ts)
- [`packages/tscache/src/entries/worker.ts#createServer`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/entries/worker.ts)
- [`packages/tscache/src/rpc/lifetime.ts#holdLifetimeLock`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/rpc/lifetime.ts)
- [`packages/tscache/src/rpc/lifetime.ts#watchLifetimeLock`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/rpc/lifetime.ts)
- [`packages/tscache/src/rpc/lifetime.ts#lockManager`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/rpc/lifetime.ts)
- [`packages/tscache/src/rpc/port-client.ts#PortClient`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/rpc/port-client.ts)

## One read, briefly

[A read, end to end](./read) follows these steps in a sequence diagram.

1. `cache.get(range)` sends a `get` request through the `PortClient`.
2. The `RpcServer` hands it to `Orchestrator.get`, with a request id of the form `clientId:seq`.
3. Without a fetcher, or with `cacheOnly: true`, the orchestrator answers with one `Engine.get`.
   Otherwise it finds the read's misses, subtracts the fetches already in flight for that cache (it
   waits for those instead), merges adjacent misses, extends each by one slot into the coverage next to
   it, and calls the fetcher once per merged range. While auth is invalid, or while the fetcher's `updateAuth`
   hook is swapping credentials, it fetches and joins nothing: those ranges come back as `'auth-pending'` at
   once.
4. Each response is applied as a put over the range it was asked for. That makes the part of the range
   below the cache's watermark, and below the response's own `meta.finalizedUntil` when it reports one,
   authoritative (see [the watermark](./data-model#the-watermark)). A response that lands after the
   cache was cleared is dropped instead. The orchestrator waits for the fetches until they settle or
   auth goes invalid, whichever comes first; fetches still running when auth goes invalid finish in the
   background.
5. If the cache was cleared while the read waited, the orchestrator runs one more round: it asks again
   for what is still missing, minus the ranges whose fetch failed or came back auth-pending. There is
   no third round.
6. It then reads the engine once, and labels the misses left by a failed fetch, or by auth going
   invalid, as `'fetch-failed'` or `'auth-pending'`.
7. The result travels back to the page with its typed arrays transferred, not copied.

Drawn from:

- [`packages/tscache/src/client/cache.ts#CacheHandle`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/client/cache.ts)
- [`packages/tscache/src/rpc/server.ts#RpcServer`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/rpc/server.ts)
- [`packages/tscache/src/orchestrator/orchestrator.ts#Orchestrator`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/orchestrator/orchestrator.ts)
- [`packages/tscache/src/orchestrator/orchestrator.ts#planRound`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/orchestrator/orchestrator.ts)
- [`packages/tscache/src/orchestrator/orchestrator.ts#coalesce`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/orchestrator/orchestrator.ts)
- [`packages/tscache/src/orchestrator/orchestrator.ts#blockedBy`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/orchestrator/orchestrator.ts)
- [`packages/tscache/src/engine/cache.ts#CacheState`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/engine/cache.ts)
- [`packages/tscache/src/orchestrator/orchestrator.ts#annotate`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/orchestrator/orchestrator.ts)
- [`packages/tscache/src/rpc/protocol.ts#transferablesOf`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/rpc/protocol.ts)
