# Sharing across tabs

In the shared hosting, every tab that loads the same worker script with the same options reaches one
SharedWorker, and so one engine. This page follows its life: the first tab starts it, a second tab
joins, a tab closes, and the worker dies.

```mermaid
sequenceDiagram
  participant T1 as Tab 1
  participant T2 as Tab 2
  participant L as Web Locks
  participant W as SharedWorker
  participant D as Persistence
  T1->>W: new SharedWorker(url, options): the browser starts the worker
  W->>L: hold tscache-worker:uuid (exclusive)
  W->>T1: hello (clientId c1, lock)
  T1->>L: queue on the lock (shared)
  T1->>W: init (fetcher)
  W-->>T1: init-ok after the fetcher module loads
  T2->>W: new SharedWorker(same url, same options): the browser connects to the running worker
  W->>T2: hello (clientId c2, the same lock)
  T2->>L: queue on the lock (shared)
  T2->>W: init (fetcher)
  W-->>T2: init-ok, the module is already loaded
  Note over T1,W: one engine: a fetch started for one tab serves the other, and events reach both
  W->>T1: evt (cacheCleared, authInvalid, persistStopped, mergeWarning)
  W->>T2: evt (the same)
  Note over T1,T2: Tab 2 closes (pagehide, not into the back/forward cache)
  T2->>W: req dispose
  T2->>L: withdraw the queued request
  Note over T2: in the same step Tab 2 closes its port
  W--xT2: res, to a port already closed; the server forgets the port
  opt that was the last connection
    W->>D: flush what the debounce still holds
  end
  Note over L,W: later the worker dies, for example with Tab 1's renderer
  L-->>T1: the lock is granted to Tab 1's queued request
  Note over T1,T2: Tab 1's pending and later calls reject with TscacheError
  T1-->>T1: workerLost (reason)
```

## The first tab

The first tab's `new SharedWorker(url, { type: 'module', extendedLifetime: true })` makes the browser
start the worker. The worker takes an exclusive Web Lock under a fresh name, `tscache-worker:<uuid>`,
and holds it until its global scope goes away. It then builds its server and greets the tab with a
`hello` that names the lock. The handshake is described in [Startup and fallback](./startup#the-handshake).

## Later tabs

A later tab constructs a SharedWorker with the same URL and the same options, and the browser connects
it to the running worker. Its port is attached to the same `RpcServer`, which gives it the next client
id. If its `init` names the module the worker already runs, it shares that load. If it carries a
context that is not the identical value (`Object.is`) the worker holds, the context takes the
`updateAuth` path, so the fetcher's hook hears it. If it names another module, its `init` is refused
with a `ConfigError` and its `createClient` rejects.

From then on the tabs share everything the engine holds: data, coverage, versions, watermarks, the
fetches in flight (a read in one tab can join a fetch started for another,
[A read, end to end](./read)) and the auth state. The server sends each event to every ready port:
`cacheCleared`, `persistStopped`, `authInvalid`, and the `mergeWarning` events of every request.

## A tab closes

On `pagehide`, unless the page is entering the back/forward cache, the client disposes itself. It
posts a `dispose` request, closes its port and withdraws its queued lock request, all in one step. The
server answers the request before it forgets the port, but the client does not wait for that answer,
which finds the port closed. A port
`close` event, where the browser fires one, also makes the server forget the port. When the last
connection goes, the server asks its persistence to write what the debounce still holds
([Persistence](./persistence)). The page creates the SharedWorker with `extendedLifetime: true`; in a
browser that supports the option, the worker is kept running for a while after its last tab, so that
write can land.

## The worker dies

Chromium runs a SharedWorker in the renderer of the tab that created it. When that renderer crashes,
the worker goes with it, and the other tabs get no `error` and no port closure. The lifetime lock
covers this: the browser releases the worker's lock with the worker, and grants it to the requests
queued on it. Each client then rejects its pending requests and every later call with a `TscacheError`,
releases what it owns, and emits `workerLost` once.

The page then creates a new client, which starts a new worker. Its memory starts empty: a cache with
`persist: true` restores what the old worker had written to IndexedDB when the page calls
`client.cache(config)` again ([Persistence](./persistence#restore)), and every other cache starts
empty.

Without Web Locks (outside a secure context) the worker names no lock and the client watches none; a
lost worker is then noticed only if the browser fires `close` on the port. A dedicated worker's client
learns of its worker's failure from the worker's `error` event instead, with the same outcome.

Drawn from:

- [`packages/tscache/src/client/hosting.ts#openShared`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/client/hosting.ts)
- [`packages/tscache/src/client/hosting.ts#openDedicated`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/client/hosting.ts)
- [`packages/tscache/src/client/client.ts#Client`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/client/client.ts)
- [`packages/tscache/src/rpc/port-client.ts#PortClient`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/rpc/port-client.ts)
- [`packages/tscache/src/rpc/server.ts#RpcServer`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/rpc/server.ts)
- [`packages/tscache/src/rpc/server.ts#Persistence`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/rpc/server.ts)
- [`packages/tscache/src/rpc/lifetime.ts#holdLifetimeLock`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/rpc/lifetime.ts)
- [`packages/tscache/src/rpc/lifetime.ts#watchLifetimeLock`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/rpc/lifetime.ts)
- [`packages/tscache/src/entries/worker.ts#sharedWorkerScope`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/entries/worker.ts)
- [`packages/tscache/src/entries/worker.ts#createServer`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/entries/worker.ts)
- [`packages/tscache/src/orchestrator/orchestrator.ts#Orchestrator`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/orchestrator/orchestrator.ts)
- [`packages/tscache/src/persist/hosted.ts#HostedPersistence`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/persist/hosted.ts)
