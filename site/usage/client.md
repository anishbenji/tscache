# The client

`createClient(options)` connects to a hosting and resolves with a `TscacheClient` once the protocol
handshake passed. Create one per page, at startup, and keep it for the page's life.

<<< @/snippets/client.ts#options{ts}

## Options

| Option               | Default    | Meaning                                                                                                                                                                                     |
| -------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workerUrl`          | none       | the `@anishbenji/tscache/worker` script as your setup serves it ([Workers](/guides/workers)); required unless `mode` is `'in-process'`, else `ConfigError`                                  |
| `mode`               | `'shared'` | where the fallback chain starts: `'shared'` → `'dedicated'` → `'in-process'`                                                                                                                |
| `handshakeTimeoutMs` | `5000`     | how long a hosting may take to say hello before the chain steps down                                                                                                                        |
| `fetcher.module`     | none       | URL of your fetcher module, which the worker `import()`s ([Writing a fetcher](/guides/fetcher))                                                                                             |
| `fetcher.context`    | none       | structured-cloneable material handed to every fetch: a token, an origin                                                                                                                     |
| `memoryBudget`       | none       | upper bound in bytes on what the worker's caches hold, a positive safe integer (else `ConfigError`); above it the least recently used pages are evicted ([Memory](/guides/patterns#memory)) |

Without `fetcher`, the cache holds only what you `put`.

`createClient` rejects with `ProtocolMismatchError` when the worker script speaks another protocol
version (a stale cached script, [after a deploy](/guides/workers#a-stale-worker-script)), which never
falls back, and with `TscacheError` when the fetcher module fails to load or has no default export with
a `fetch` function.

The fetcher module's URL and the tscache version name the SharedWorker: tabs that agree on both, and on
the worker URL, share one worker, and a deploy that changes any of them starts a worker of its own
([Stale scripts after a deploy](/guides/workers#stale-scripts-after-a-deploy)). Pass the same
`fetcher.module` string on every page.

## client.mode

The hosting that won: `'shared'`, `'dedicated'` or `'in-process'`. Check it once while setting up: an
unexpected `'in-process'` usually means the worker URL did not resolve.

<<< @/snippets/client.ts#fallback{ts}

## client.cache(config)

Opens a cache, creating it if no tab has yet, and resolves with its [handle](/usage/cache). Every tab
calls it with the same config. A config whose structure differs from the live cache's (`interval`,
`alignmentOffset`, `fields`, `gapSplitK`, `segmentSlotCap`, `warnOnOverlapDiff`) rejects with
`ConfigError`; `version` and `finalizedUntil` apply only on creation.

<<< @/snippets/errors.ts#config{ts}

## client.updateAuth(context)

Hands new fetcher context to the worker. The fetcher's optional `updateAuth` hook runs, the context is
replaced for every later fetch, and if credentials were marked invalid, fetching resumes. Reads that
came back `'auth-pending'` are not retried for you: read again.

<<< @/snippets/client.ts#auth{ts}

## client.clearAll()

Empties every cache, keeping their configs ([Invalidation and clearing](/concepts/invalidation)). Where
the browser has IndexedDB it also empties the [persisted](/guides/persistence) records, from a client of
any hosting, and resolves once they are gone or the clear gave up; it never rejects for a disk failure.

From 0.3.0 it also reaches every other SharedWorker of the origin of 0.3.0 or later, such as an older
deploy's that tabs left open still use: each clears its caches and the disk too, so none of their tabs
keeps the data. A 0.1.0 or 0.2.0 worker is not reached
([Sensitive data and logout](/guides/persistence#sensitive-data-and-logout)). The promise does not wait
for those workers, and their tabs can hear `cacheCleared` more than once for one call.

<<< @/snippets/client.ts#clear-all{ts}

## client.memoryStats()

Resolves with what the worker's caches hold now: the budget in force (absent without one), the bytes the
cached points hold, the part pinned by pending reads and provisional bars, the pages evicted so far, and
one row per cache, ascending by id. In a SharedWorker it covers the caches of every tab of that worker, not those of another deploy's worker. It rejects with
`TscacheError` against a worker script from before memory budgets
(`client.features.has('memoryBudget')` is then false).

```ts
const { budget, bytes, evictedPages } = await client.memoryStats();
```

## client.superseded

`undefined`, until a worker of a newer generation of the application (another tscache version, fetcher
module or worker build) runs in the origin; then `{ lib }`, with that worker's tscache version. The
`superseded` event fires when it is set. When the event reached the tab before `createClient`
resolved, the property is set from the start and the event follows on the next macrotask or with the
worker's next message, whichever comes first, so a listener attached right after
`await createClient()` hears it. An event still on its way then (the worker was superseded, but its
message had not reached the tab) arrives live and sets the property when it does. This tab's worker
no longer persists, the tab keeps working from memory and its fetcher, and a reload joins the newer
worker
([Stale scripts after a deploy](/guides/workers#older-tabs-are-told-superseded)).

Only a SharedWorker reports it. Where `client.features.has('superseded')` is false (a dedicated worker,
in-process, an older worker script) the property stays `undefined`, which then means "not known".

<<< @/snippets/client.ts#superseded{ts}

## client.on(event, fn) and client.off(event, fn)

Subscribes to [events](/concepts/events); `on` returns the unsubscribe.

## client.dispose()

Releases the port and terminates a dedicated worker this client owns. A SharedWorker is never
terminated by a client, since other tabs may use it. Later calls reject with `TscacheError`. Idempotent.

<<< @/snippets/client.ts#dispose{ts}

A page that simply closes needs no teardown: the client disposes itself on `pagehide`, unless the page
enters the back/forward cache.

## In-process clients

<<< @/snippets/client.ts#in-process{ts}

Pinned to `'in-process'`, a client runs its own engine in the current realm, behind the same message
protocol. It needs no worker and no DOM, so server code and Node use it. Two in-process clients do not
share data.

## Losing the worker

When the worker behind a client goes away (in Chromium, a SharedWorker dies with the renderer of the tab
that created it), every pending and later call rejects with `TscacheError` and the client emits
`workerLost` once. Create a new client; it starts a new worker, whose memory starts empty. A cache with
`persist: true` restores what the old worker had written to IndexedDB at the new client's
`client.cache()` ([Persistence](/guides/persistence)).

<<< @/snippets/client.ts#lost{ts}

Detection uses Web Locks, so it needs a secure context (HTTPS or `localhost`). See
[Workers and fallback](/guides/workers#losing-the-worker).
