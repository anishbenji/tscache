# The client

`createClient(options)` connects to a hosting and resolves with a `TscacheClient` once the protocol
handshake passed. Create one per page, at startup, and keep it for the page's life.

<<< @/snippets/client.ts#options{ts}

## Options

| Option | Default | Meaning |
|---|---|---|
| `workerUrl` | none | the `tscache/worker` script as your setup serves it ([Workers](/guides/workers)); required unless `mode` is `'in-process'`, else `ConfigError` |
| `mode` | `'shared'` | where the fallback chain starts: `'shared'` → `'dedicated'` → `'in-process'` |
| `handshakeTimeoutMs` | `5000` | how long a hosting may take to say hello before the chain steps down |
| `fetcher.module` | none | URL of your fetcher module, which the worker `import()`s ([Writing a fetcher](/guides/fetcher)) |
| `fetcher.context` | none | structured-cloneable material handed to every fetch: a token, an origin |

Without `fetcher`, the cache holds only what you `put`.

`createClient` rejects with `ProtocolMismatchError` when the worker speaks another protocol version (a
stale cached script, or two package versions), which never falls back, and with `TscacheError` when the
fetcher module fails to load or has no default export with a `fetch` function.

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

Empties every cache, keeping their configs ([Invalidation and clearing](/concepts/invalidation)).

<<< @/snippets/client.ts#clear-all{ts}

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
`workerLost` once. Create a new client; it starts a new worker with an empty cache.

<<< @/snippets/client.ts#lost{ts}

Detection uses Web Locks, so it needs a secure context (HTTPS or `localhost`). See
[Workers and fallback](/guides/workers#losing-the-worker).
