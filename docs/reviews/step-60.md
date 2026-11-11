# Step 60 — How it works, part 2: the flows

Branch: `docs/60-how-it-works-flows` · Status: built, not yet reviewed

Seven new pages in the docs site's "How it works" section, each a Mermaid sequence diagram (the startup
page adds a flowchart of the hosting chain) with a short walkthrough and the `path#symbol` list it is
drawn from: startup and fallback, a read end to end, sharing across tabs, fences and invalidation, auth
refresh, persistence, and live feeds. The traces below map each diagram element and each factual
sentence to the code that backs it. Two pages also had an inaccurate sentence about a lost worker fixed.

## Scope

| Commit                                                     | What                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs(site): show sequence diagrams at their natural size` | `site/.vitepress/config.ts`: Mermaid's `sequence` options (`useMaxWidth: false`, `wrap: true`, 140 px actors, 14 px text); `site/.vitepress/theme/diagrams.css`: `.mermaid` scrolls sideways. Flowcharts keep the default, so the step 59 package map is unchanged. |
| `docs(site): the how-it-works flows`                       | The seven pages in `site/how-it-works/`, their sidebar entries after the existing three, and the links from the overview page.                                                                                                                                      |
| `docs(site): a new worker restores the persisted caches`   | `site/guides/workers.md` ("Losing the worker") and `site/usage/client.md` ("Losing the worker"): a new worker's memory starts empty, but a `persist: true` cache restores at the new client's `cache()`.                                                            |
| `docs(review): step 60`                                    | This file, and the file counts in `docs/INDEX.md`.                                                                                                                                                                                                                  |

### Decisions taken

- **One page per flow**, ordered for reading rather than in the brief's order: startup first (everything
  else needs a connected client), then the read, tabs, fences, auth, persistence and live feeds.
- **Sequence diagrams at their natural size.** With Mermaid's default (`useMaxWidth: true`) the flows,
  1,200 to 2,100 px wide as first drawn, scaled to the 688 px column and their text shrank to 5 to 8 px.
  They now wrap text, use narrower actors and keep their natural width (750 to 1,105 px); the four with
  five or six participants scroll sideways in the column. Option not taken: a wider page layout for
  these pages (theme work beyond this step).
- **The live feed is reference code, not the package.** Its page says so in its first paragraph, and
  its anchors point at `reference/shared/src/live.ts`, `reference/shared/src/session.ts` and
  `integrations/vanilla/series.ts`, in the same `[`path#symbol`](…/blob/main/path)` form. If step 61's
  anchor check only accepts `packages/tscache/src/` paths, those four anchors need it widened.
- **The `usage/client.md` sentence** was fixed with the one in `guides/workers.md`, which the brief
  named: it is the same claim on another page of the site.
- **Diagram shortcuts.** Where the `RpcServer` only passes a request on, some diagrams draw the page's
  arrow straight to the orchestrator; the pages say so (fences, auth), and the read and startup
  diagrams draw it.

## Traces

Paths are relative to `packages/tscache/src/` unless they start with `reference/`, `integrations/` or
`site/`.

### Startup and fallback (`site/how-it-works/startup.md`)

| Element or sentence                                                                                                 | Backed by                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Chain `shared → dedicated → in-process`, starting at `options.mode`, default `shared`                               | `client/client.ts#CHAIN`, `client/client.ts#chainFrom`                                                                    |
| `workerUrl` required unless the chain starts at `in-process`                                                        | `client/client.ts#resolve`                                                                                                |
| Flowchart: `HostingError` steps down; any other error rejects; the last hosting's `HostingError` rejects            | `client/client.ts#connect` (`!(error instanceof HostingError) \|\| next === undefined` rethrows)                          |
| Constructor missing or throwing is a `HostingError`                                                                 | `client/hosting.ts#openShared`, `client/hosting.ts#openDedicated`                                                         |
| Worker `error` before `init-ok`, no `hello` within `handshakeTimeoutMs` (default 5000 ms) are `HostingError`s       | `client/hosting.ts#handshake` (`onError`, `timer`), `client/client.ts#DEFAULT_HANDSHAKE_TIMEOUT_MS`                       |
| Lifetime lock granted before `init-ok` fails the shared hosting                                                     | `client/hosting.ts#openShared` (`connected === undefined` → `fail(new HostingError(…))`)                                  |
| Each step recorded, emitted as `modeFallback` (`from`, `to`, `reason`) on the next macrotask                        | `client/client.ts#connect` (`fallbacks.push`), `client/client.ts#Client` (constructor, `setTimeout(…, 0)`)                |
| `ProtocolMismatchError` and the `init-err` error reject `createClient`                                              | `rpc/port-client.ts#PortClient` (`connect`: `onHello` mismatch, `init-err` → `fromWireError`), `client/client.ts#connect` |
| In-process chunk failing to load is a `HostingError`                                                                | `client/hosting.ts#openInProcess`                                                                                         |
| `new SharedWorker(url, { type: 'module', extendedLifetime: true })`                                                 | `client/hosting.ts#openShared`                                                                                            |
| Worker takes exclusive `tscache-worker:<uuid>`; without Web Locks the lock is `undefined`                           | `rpc/lifetime.ts#holdLifetimeLock`, `rpc/lifetime.ts#lockManager`                                                         |
| Worker listens for `connect` at once; ports wait until the lock is held                                             | `entries/worker.ts` (module body: `waiting`, `holdLifetimeLock(…).then`), `entries/worker.ts#sharedWorkerScope`           |
| `hello` carries protocol, lib, client id (`c1`, `c2`, …), lock                                                      | `rpc/server.ts#RpcServer` (`attach`), `rpc/protocol.ts#Hello`                                                             |
| Timer stops at `hello`; the rest is unbounded                                                                       | `client/hosting.ts#handshake` (`clearTimeout(timer)` in the `afterHello` callback)                                        |
| Page queues on the lock (shared mode) at `hello`                                                                    | `client/hosting.ts#openShared` (`onHello` → `watchLifetimeLock`), `rpc/lifetime.ts#watchLifetimeLock` (`mode: "shared"`)  |
| `init` carries protocol and fetcher module and context                                                              | `rpc/port-client.ts#PortClient` (`connect`: `reply`), `rpc/protocol.ts#Init`, `client/client.ts#fetcherOf`                |
| Server checks protocol, then `orchestrator.load(fetcher)`                                                           | `rpc/server.ts#RpcServer` (`#init`)                                                                                       |
| One module per worker; same module shares the load; other module → `ConfigError`; a failed load frees the slot      | `orchestrator/orchestrator.ts#Orchestrator` (`load`, `#loading`, `#module`)                                               |
| A default export without `fetch` fails the load                                                                     | `orchestrator/orchestrator.ts#Orchestrator` (`#import`)                                                                   |
| `init-err` → server drops the port; `init-ok` → port ready                                                          | `rpc/server.ts#RpcServer` (`#init`, `#drop`)                                                                              |
| The aborted side closes its end of the port                                                                         | `rpc/port-client.ts#PortClient` (`connect`: `finish` → `port.close?.()`)                                                  |
| Dedicated: `new Worker(url, { type: 'module' })`, global scope attached as the port, no lock, terminated on failure | `client/hosting.ts#openDedicated`, `entries/worker.ts#dedicatedWorkerScope`, `entries/worker.ts#createServer`             |
| In-process: `import()`, `Engine` and `RpcServer` in the realm, `MessageChannel`, no timer, no lock                  | `client/hosting.ts#openInProcess`, `client/in-process.ts#connectInProcess`                                                |

### A read, end to end (`site/how-it-works/read.md`)

| Element or sentence                                                                  | Backed by                                                                                                                                       |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `req get (cacheId, range, options)` through the `PortClient`                         | `client/cache.ts#CacheHandle` (`get`), `rpc/port-client.ts#PortClient` (`request`)                                                              |
| `get(cacheId, range, options, requestId c1:7)`, id `clientId:seq`                    | `rpc/server.ts#RpcServer` (`#handlers.get`)                                                                                                     |
| No fetcher or `cacheOnly: true` → one `Engine.get`                                   | `orchestrator/orchestrator.ts#Orchestrator` (`get`)                                                                                             |
| Snap outward; coverage over the request and one slot beyond each end, no points read | `orchestrator/orchestrator.ts#Orchestrator` (`get`: `snapOut`; `#round`: `probe`, `engine.coverage`), `engine/cache.ts#CacheState` (`coverage`) |
| Need minus joinable in-flight fetches; joined fetches awaited                        | `orchestrator/orchestrator.ts#planRound`, `orchestrator/orchestrator.ts#Orchestrator` (`#round`)                                                |
| Joinable: same clear generation, same auth generation, not fenced                    | `orchestrator/orchestrator.ts#Orchestrator` (`#round`: `joinable` filter)                                                                       |
| Auth invalid or hook running → nothing fetched or joined, `'auth-pending'` at once   | `orchestrator/orchestrator.ts#Orchestrator` (`#round`: `gated`; `#rounds`)                                                                      |
| Merge adjacent; extend one slot into adjacent coverage                               | `orchestrator/orchestrator.ts#coalesce`                                                                                                         |
| `fetch(range, interval, alignmentOffset, context)`, context copied                   | `orchestrator/orchestrator.ts#Orchestrator` (`#run`: `structuredClone(context)`), `types.ts#Fetcher`                                            |
| Plan and listing in one synchronous step                                             | `orchestrator/orchestrator.ts#Orchestrator` (`#round`: `#issue`, `enlist` before returning)                                                     |
| Stale response dropped; else put over the asked range                                | `orchestrator/orchestrator.ts#Orchestrator` (`#run`: generation check; `#apply`: `engine.put(cacheId, response, { range })`)                    |
| Authoritative below the watermark and `meta.finalizedUntil`                          | `engine/cache.ts#CacheState` (`#putValid`, `#cover`)                                                                                            |
| `mergeWarning` to every tab under the starting read's id                             | `orchestrator/orchestrator.ts#Orchestrator` (`#apply`), `rpc/server.ts#RpcServer` (`#broadcast`)                                                |
| Fetch leaves the list in the same step                                               | `orchestrator/orchestrator.ts#Orchestrator` (`#run`: `finally leave()`, `#leave`)                                                               |
| Wait until all settle or auth goes invalid                                           | `orchestrator/orchestrator.ts#Orchestrator` (`#awaitFetches`)                                                                                   |
| Second round when cleared meanwhile, minus failed or auth ranges; no third           | `orchestrator/orchestrator.ts#Orchestrator` (`#rounds`), `orchestrator/orchestrator.ts#blockedBy`                                               |
| One read; misses cut and labelled `'fetch-failed'`, `'auth-pending'`, `'uncached'`   | `orchestrator/orchestrator.ts#Orchestrator` (`get`: the `read` callback), `orchestrator/orchestrator.ts#annotate`                               |
| Result's typed arrays transferred; nothing sent when the port went                   | `rpc/server.ts#RpcServer` (`#request`), `rpc/protocol.ts#transferablesOf`                                                                       |
| Tab B joins X, fetches Y, answers after both                                         | `orchestrator/orchestrator.ts#Orchestrator` (`#round` returns joined then own; `#rounds` awaits them all)                                       |

### Sharing across tabs (`site/how-it-works/tabs.md`)

| Element or sentence                                                                                              | Backed by                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| First tab's construction starts the worker; lock held for the worker's life; `hello` names it                    | `client/hosting.ts#openShared`, `rpc/lifetime.ts#holdLifetimeLock`, `entries/worker.ts` (module body)                                           |
| Later tabs attach to the same `RpcServer`, next client id                                                        | `entries/worker.ts` (one `server` for every `connect`), `rpc/server.ts#RpcServer` (`attach`: `#nextClient`)                                     |
| Same module shares the load; a non-identical (`Object.is`) context takes `updateAuth`; another module is refused | `orchestrator/orchestrator.ts#Orchestrator` (`load`)                                                                                            |
| Tabs share data, in-flight fetches, auth state                                                                   | `rpc/server.ts#RpcServer` (one `#engine`, one `#orchestrator`)                                                                                  |
| Events to every ready port: `cacheCleared`, `persistStopped`, `authInvalid`, `mergeWarning`                      | `rpc/server.ts#RpcServer` (`#broadcast`, constructor, `persistStopped`, `#put`), `orchestrator/auth.ts#AuthState` (`invalidate`)                |
| `pagehide` not persisted → dispose                                                                               | `client/client.ts#Client` (`#onPageHide`)                                                                                                       |
| `dispose` request answered, then the port forgotten; the client does not wait                                    | `rpc/port-client.ts#PortClient` (`dispose`), `rpc/server.ts#RpcServer` (`#request`: `dispose` → `#drop`)                                        |
| Queued lock request withdrawn                                                                                    | `client/hosting.ts#openShared` (`terminate: () => watch.abort()`)                                                                               |
| A port `close` event also drops the connection                                                                   | `rpc/server.ts#RpcServer` (`attach`: `onClose`), `rpc/protocol.ts#listen`                                                                       |
| Last connection → flush                                                                                          | `rpc/server.ts#RpcServer` (`#drop`), `rpc/server.ts#Persistence` (`flush`), `persist/hosted.ts#HostedPersistence` (`flush`)                     |
| `extendedLifetime` keeps the worker running after its last tab so the write can land                             | `client/hosting.ts#openShared` (comment on the option)                                                                                          |
| Renderer crash: no `error`, no port closure; lock granted to queued requests                                     | `rpc/lifetime.ts` (module comment), `rpc/lifetime.ts#watchLifetimeLock`                                                                         |
| Pending and later calls reject with `TscacheError`, owned things released, `workerLost` once                     | `client/hosting.ts#openShared` (`connected.abort`), `rpc/port-client.ts#PortClient` (`abort`, `#shutDown`), `client/client.ts#Client` (`#lose`) |
| New worker: memory empty; `persist: true` restores at `cache()`                                                  | `entries/worker.ts#createServer` (new `Engine`), `rpc/server.ts#RpcServer` (`#cache` → `persistence.open`)                                      |
| No Web Locks: no lock named or watched; only a port `close` is noticed                                           | `rpc/lifetime.ts#holdLifetimeLock`, `client/hosting.ts#openShared` (`lock === undefined` returns), `rpc/port-client.ts#PortClient` (`onClose`)  |
| Dedicated: the worker's `error` event, same outcome                                                              | `client/hosting.ts#openDedicated` (`onFatal`)                                                                                                   |

### Fences and invalidation (`site/how-it-works/fences.md`)

| Element or sentence                                                                         | Backed by                                                                                                                                  |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Generation counts every `cacheCleared` (`'manual'`, `'clear-all'`, `'version-mismatch'`)    | `orchestrator/orchestrator.ts#Orchestrator` (constructor listener, `#generationOf`), `engine/engine.ts#EngineEvents`                       |
| Each fetch records its generation                                                           | `orchestrator/orchestrator.ts#Orchestrator` (`#issue`, `Inflight.generation`)                                                              |
| Version mismatch inside the put: clear, write, then the event; the first version is adopted | `engine/cache.ts#CacheState` (`#putValid`, `#applyVersion`), `engine/engine.ts#Engine` (`cache`: `onVersionClear`)                         |
| Server forwards `cacheCleared` to every ready port                                          | `rpc/server.ts#RpcServer` (constructor: `engine.on("cacheCleared", …)`)                                                                    |
| Response of another generation dropped                                                      | `orchestrator/orchestrator.ts#Orchestrator` (`#run`)                                                                                       |
| Round compares planned and current generation; second round minus failed or auth; final     | `orchestrator/orchestrator.ts#Orchestrator` (`#rounds`), `orchestrator/orchestrator.ts#blockedBy`, `orchestrator/orchestrator.ts#annotate` |
| Older generation never joined                                                               | `orchestrator/orchestrator.ts#Orchestrator` (`#round`: `joinable`)                                                                         |
| `invalidate` forgets coverage, snapped outward, keeps points; invalid range throws first    | `orchestrator/orchestrator.ts#Orchestrator` (`invalidate`), `engine/cache.ts#CacheState` (`invalidate`), `coverage.ts#CoverageIndex`       |
| Overlapping in-flight fetches fenced; set once                                              | `orchestrator/orchestrator.ts#Orchestrator` (`invalidate`, `Inflight.fenced`)                                                              |
| Later reads cannot join a fenced fetch                                                      | `orchestrator/orchestrator.ts#Orchestrator` (`#round`: `!e.fenced`)                                                                        |
| Fenced responses still applied; a read that joined before goes on waiting                   | `orchestrator/orchestrator.ts#Orchestrator` (`#run` does not read `fenced`; `#rounds` awaits its list)                                     |

### Auth refresh (`site/how-it-works/auth.md`)

| Element or sentence                                                                        | Backed by                                                                                                                             |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Recognised by marker `code === 'tscache:auth-invalid'`                                     | `errors.ts#isAuthInvalidError`, `errors.ts#AUTH_INVALID_CODE`, `errors.ts#AuthInvalidError`                                           |
| Flip only for a fetch of the current auth generation                                       | `orchestrator/orchestrator.ts#Orchestrator` (`#refused`)                                                                              |
| Broadcast once per flip, with error and the refused fetch's context                        | `orchestrator/auth.ts#AuthState` (`invalidate`), `orchestrator/orchestrator.ts#Orchestrator` (`#run`: `context`)                      |
| Diagram order: events before the result                                                    | `orchestrator/auth.ts#AuthState` (`invalidate` resolves waiters, then broadcasts synchronously; the get continues later)              |
| Dedicated or in-process: one client hears it                                               | `client/hosting.ts#openDedicated` (one worker per client), `client/in-process.ts#connectInProcess` (one engine per client)            |
| Waiting reads released; outstanding fetches `'auth-pending'`, finish in the background     | `orchestrator/orchestrator.ts#Orchestrator` (`#awaitFetches`)                                                                         |
| While invalid: nothing fetched or joined; `cacheOnly` never reaches it                     | `orchestrator/orchestrator.ts#Orchestrator` (`#round`: `gated`; `get`: `cacheOnly` early return)                                      |
| `updateAuth` serialised; waits for the load; hook gets a copy; reads gated while it runs   | `orchestrator/orchestrator.ts#Orchestrator` (`updateAuth`: `#authUpdate`, `#loading`, `#transitioning`, `structuredClone`)            |
| Context and generation switch together, auth valid; a throwing hook leaves the old context | `orchestrator/orchestrator.ts#Orchestrator` (`updateAuth`: `apply`), `orchestrator/auth.ts#AuthState` (`restore`)                     |
| No fetcher → no-op                                                                         | `orchestrator/orchestrator.ts#Orchestrator` (`updateAuth`: `#loading === undefined`)                                                  |
| Nothing retried; pages call `get` again                                                    | No retry exists in `orchestrator/orchestrator.ts#Orchestrator`; consistent with `site/guides/auth.md` steps 5–6                       |
| Joining tab's context through `updateAuth`                                                 | `orchestrator/orchestrator.ts#Orchestrator` (`load`)                                                                                  |
| Page API and event                                                                         | `client/client.ts#TscacheClient` (`updateAuth`), `client/events.ts#ClientEmitter` (`authInvalid`), `types.ts#Fetcher` (`updateAuth?`) |

### Persistence (`site/how-it-works/persistence.md`)

| Element or sentence                                                                                          | Backed by                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Only the SharedWorker persists; the others only empty the database at `clearAll`                             | `entries/worker.ts#createServer`, `client/in-process.ts#connectInProcess`, `persist/clear-only.ts#ClearOnlyPersistence`, `persist/clear-only.ts#lazyIdbStore`              |
| Chunk loaded with `import()` at the first persisted open or `clearAll`                                       | `persist/hosted.ts#HostedPersistence` (`open`, `clearAll`, `#start`), `entries/worker.ts` (`lazyPersist`)                                                                  |
| `cache()` answers once `open` settled                                                                        | `rpc/server.ts#RpcServer` (`#cache`)                                                                                                                                       |
| Calls wait in arrival order; failed or late chunk → persistence off, `'unavailable'`                         | `persist/hosted.ts#HostedPersistence` (`#later`, `#settle`, `#stopUnloaded`, `timeoutMs ?? 5000`)                                                                          |
| Load deadline from `open`, import included; late load stops `'unavailable'`                                  | `persist/persister.ts#Persister` (`open`: `loadTimer`, `startedAt`)                                                                                                        |
| Store fails to open → all `'unavailable'`; read fails → `'error'`                                            | `persist/persister.ts#Persister` (`#ensureStore`, `#openFailed`, `#load`)                                                                                                  |
| Database opened once per persister                                                                           | `persist/persister.ts#Persister` (`#storeFor`, `#store`), `persist/idb-store.ts#openIdbStore`                                                                              |
| Restore: structure and version checked, version adopted, watermark forwards only, pages minus provisional    | `engine/restore.ts#restore`                                                                                                                                                |
| Mismatching records not applied, rewritten                                                                   | `engine/restore.ts#restore` (`rewrite`), `persist/persister.ts#Persister` (`#load`: `rewrite` → `#request`)                                                                |
| A mutation during the load abandons it                                                                       | `persist/persister.ts#Persister` (`#change`, `#mutate`, `#abandon`)                                                                                                        |
| Hooks report write (clipped below the provisional region), watermark, remove, clear, version                 | `engine/cache.ts#CacheChange`, `engine/cache.ts#CacheState` (`#reportWrite`, `#reportWatermark`, `invalidate`, `clear`, `#applyVersion`), `engine/engine.ts#observeCaches` |
| The engine sets no timers                                                                                    | `engine/engine.ts` (module comment: "No DOM, worker or timer use")                                                                                                         |
| Quiet spell `debounceMs` 1000, capped by `maxDelayMs` 5000                                                   | `persist/persister.ts#PersisterOptions`, `persist/persister.ts#Persister` (`#dueOf`, `#quiet`)                                                                             |
| Removals due at once; ops answer once durable or stopped                                                     | `persist/persister.ts#Persister` (`#change`: `REMOVALS`), `persist/persister.ts#durably`, `rpc/server.ts#RpcServer` (`#durably`)                                           |
| One job at a time, removals first; plan from memory; one transaction, strict with a removal                  | `persist/persister.ts#Persister` (`#before`, `#start`, `#plan`), `persist/store.ts#WritePlan`, `persist/store.ts#PersistStore`                                             |
| Last connection → every dirty cache's flush due now                                                          | `rpc/server.ts#RpcServer` (`#drop`), `persist/persister.ts#Persister` (`flush`)                                                                                            |
| `QuotaExceededError` stops at once, no retry; dirty state and jobs dropped                                   | `persist/persister.ts#Persister` (`#rejected`, `#stop`, `#drop`, `#dropJobs`)                                                                                              |
| `onStopped` → `persistStopped` to every ready port; `client.on` and the handle's `on` receive it             | `entries/worker.ts#createServer` (`onStopped`), `rpc/server.ts#RpcServer` (`persistStopped`), `client/cache.ts#CacheHandle` (`on`)                                         |
| Cleanup deletes the records; its failure ignored                                                             | `persist/persister.ts#Persister` (`#stop`: cleanup job, `#attemptCleanup`)                                                                                                 |
| Other rejections retry after `debounceMs` under the same deadline; expiry stops `'error'` or `'unavailable'` | `persist/persister.ts#Persister` (`#rejected`, `#expire`)                                                                                                                  |

### Live feeds (`site/how-it-works/live-feeds.md`)

| Element or sentence                                                                            | Backed by                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lock and channel both named `tscache-reference:feed:<cache id>`; the holder runs the source    | `reference/shared/src/live.ts#liveFeed` (`name`, `BroadcastChannel`, `navigator.locks.request`)                                                                                                                                   |
| Sources: SSE, WebSocket, polling                                                               | `reference/shared/src/live.ts#eventSource`, `reference/shared/src/live.ts#webSocket`, `reference/shared/src/live.ts#polling`                                                                                                      |
| Opening: holder's `onOpened`, then `opened` on the channel; other tabs' `onOpened`             | `reference/shared/src/live.ts#liveFeed` (`holder.opened`, `channel.onmessage`)                                                                                                                                                    |
| Catch-up read with a fetch up to the forming bar, while following the market                   | `reference/shared/src/session.ts#startSession` (`onOpened`, `catchUp`)                                                                                                                                                            |
| Holder puts the batch without a range, redraws, then passes it                                 | `reference/shared/src/live.ts#liveFeed` (`holder.pushed` → `apply(…, true)` → `cache.put`, then `pass`)                                                                                                                           |
| A put without a range adds and overwrites, claims its own span below the watermark             | `engine/cache.ts#CacheState` (`#putValid`: `authority ?? spanOf(points)`, `#cover`)                                                                                                                                               |
| Shared hosting: other tabs do not put; redraw reads with `cacheOnly: true`                     | `reference/shared/src/live.ts#liveFeed` (`apply`: `held \|\| mode !== "shared"`), `reference/shared/src/session.ts#startSession` (`onBatch` → `bars.refresh`), `integrations/vanilla/series.ts#series` (`refresh` → `read(true)`) |
| A cache of its own: the tab puts the batch itself                                              | `reference/shared/src/live.ts#liveFeed` (`apply`)                                                                                                                                                                                 |
| Polling: fetching `get` of the span since the last complete poll, then `polled` on the channel | `reference/shared/src/live.ts#polling`, `reference/shared/src/live.ts#liveFeed` (`holder.polled`)                                                                                                                                 |
| Handover: lock released, next waiting tab starts its source                                    | `reference/shared/src/live.ts#liveFeed` (lock callback holds until `stop` aborts; teardown)                                                                                                                                       |

### Sentences changed elsewhere

| Page                                             | Sentence                                                                  | Backed by                                                                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `site/guides/workers.md`, `site/usage/client.md` | A new worker's memory starts empty; `persist: true` restores at `cache()` | `entries/worker.ts#createServer` (new `Engine`), `rpc/server.ts#RpcServer` (`#cache`), `persist/persister.ts#Persister` (`open`) |

## Contradictions and drift found

The code was followed in every case. Nothing here changes behaviour, and neither the architecture
document nor the code was changed.

- `docs/architecture.md` §8 N32 says the app "creates a new client, which starts a new worker with an
  empty cache". Only memory starts empty: a `persist: true` cache restores from IndexedDB at the new
  client's `cache()` (`rpc/server.ts#RpcServer` `#cache` → `persist/persister.ts#Persister` `open`).
  The site pages are fixed; the decision row is left for the user.
- The same sentence, accurate only for caches without `persist: true`, remains in
  `docs/guides/worker-setup.md` ("it starts a new worker, with an empty cache") and in the comment of
  `integrations/shared/connection.ts` (`connect`). Not changed here (outside the site). The examples and
  e2e specs that say it use no persisted cache, so they are accurate.
- N32's text has shared-mode clients queue on the lock "after the handshake"; the code queues at
  `hello`. Its own implementation note (step 68) records this, so it is not a new contradiction.
- Observed while verifying, not a contradiction: on every page with a Mermaid diagram, including step
  59's package map, `vitepress-plugin-mermaid` first renders a "Syntax error in text" box and replaces
  it with the diagram within about 150 ms. A screenshot taken at load time can catch the error box; a
  reader may see a brief flash. Not investigated further.

## Verification

- `bun run docs:check` passes (exit 0: `tsc -p site`, `tsc -p site/scripts`, the module-graph check),
  after `bun run build` of the package.
- `bun run docs:build` builds the site.
- Rendering, in Chromium through Playwright (through the heavy-job lock): a script serves
  `site/.vitepress/dist`, opens the seven flow pages and the package map in a light and a dark colour
  scheme, waits until each page has the expected number of `.mermaid svg` elements and none is an error
  render, and checks: the root's `dark` class matches the scheme; each diagram is a real render (no
  "Syntax error"), with its type (`sequence` or `flowchart-v2`); each sequence diagram draws exactly as
  many message arrows as its source has `->>`/`-->>` lines (startup 11, read 18, tabs 19, fences 14 and
  10, auth 15, persistence 12, 8 and 5, live feeds 21); no console error. All 16 page and scheme
  combinations pass. Each diagram was also captured as an element screenshot and inspected by eye in
  both themes: text is legible at 14 px and follows the theme, no label is clipped.
- Anchors: a scratch script resolved all 161 `[`path#symbol`](url)` anchors on the "How it works"
  pages (each file exists, the symbol is declared in it, the link is the same path on `main`). All of
  this step's anchors resolve. The five it reports unresolved are step 59's package-map anchors to
  re-exports (`export { … } from`), which the scratch script does not follow; step 61's check decides
  those.
- `bunx biome check site` reports nothing.
- `~/code/tscache-reports/bin/heavy-run.sh "60 child: ci" bun run ci` on the final head: see the
  child's report.

## Not verified

- Browsers other than Chromium, and narrow screens: the wider diagrams scroll sideways, as the step 59
  SVGs do below 600 px.
- The anchors against step 61's CI check, which is not on `main` yet.
- The statement that `extendedLifetime` keeps a worker running after its last tab rests on the comment
  in `client/hosting.ts#openShared` and the persistence guide, not on a test in this step.
