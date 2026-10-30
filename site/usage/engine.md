# The engine

`tscache/engine` exports `Engine`, the engine every hosting runs, without a worker, a port or a fetcher.
Its methods are synchronous and take the cache id first. Use it in Node, in tests, or to build
persistence; in a page, use `createClient`, which runs this engine in a worker for you.

<<< @/snippets/engine.ts#engine{ts}

| Method | Does |
|---|---|
| `cache(config)` | get-or-create; returns the resolved config the cache was created with |
| `has(id)` | whether the cache exists; never throws |
| `configOf(id)` | the resolved config |
| `get(id, range, { snapshot? })` | the current state only; there is no fetcher, so misses are `'uncached'` |
| `put(id, batch, options?)` | as `CacheHandle.put`, returning `{ warnings }`; arrays are copied, not transferred |
| `coverage(id, range)` | the covered sub-ranges, without reading points |
| `invalidate(id, range)`, `clear(id)`, `clearAll()`, `setFinalizedUntil(id, t)` | as on the handle |
| `snapshot(id, range)` | a snapshot of the range, without a read |
| `hydrate(id, snapshot)` | as `CacheHandle.hydrate` |
| `on(event, fn)`, `off(event, fn)` | the one engine event, `cacheCleared` |

Every method that takes an id throws `UnknownCacheError` for an id without a cache, except `has`. The
entry also exports the errors, `encodeSnapshot`, `decodeSnapshot`, `DTYPES` and the types, so Node code
needs nothing else. It has no DOM, worker or timer code.
