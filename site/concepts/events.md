# Events

Events come in three scopes over one channel. Subscribe with `client.on(event, fn)`, which hears every
event of that type, or with `cache.on(event, fn)`, which hears the cache- and request-scoped events of
that cache only. Both return the unsubscribe function; `client.off(event, fn)` also works. Listeners run
on the page; one that throws does not stop the others.

| Event            | Scope   | Payload                                              | When                                                                                                                                                                 |
| ---------------- | ------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `authInvalid`    | client  | `{ error: { name, message }, context }`              | the fetcher threw `AuthInvalidError`; sent to every tab, with the fetcher context the refused fetch was issued with                                                  |
| `modeFallback`   | client  | `{ from, to, reason }`                               | a hosting failed while connecting and the chain stepped down                                                                                                         |
| `workerLost`     | client  | `{ reason }`                                         | the worker behind this client is gone; at most once per client, never after `dispose()`                                                                              |
| `cacheCleared`   | cache   | `{ cacheId, reason }`                                | the cache was emptied: `'manual'`, `'clear-all'` or `'version-mismatch'`                                                                                             |
| `persistStopped` | cache   | `{ cacheId, reason, error? }`                        | a persisted cache stopped persisting: `'quota-exceeded'`, `'unavailable'` or `'error'` (with the failure); it goes on in memory ([Persistence](/guides/persistence)) |
| `cacheChanged`   | cache   | `{ cacheId, written, removed, cleared, requestId? }` | what a read of the cache returns may have changed: a put, a fetch, a hydrate, an invalidate, a moved watermark or a clear ([Change events](#change-events))          |
| `mergeWarning`   | request | `{ cacheId, requestId, range, fields }`              | with `warnOnOverlapDiff`, a write changed values the cache already held outside the volatile region                                                                  |

## Change events

`cacheChanged` tells a view that what a `get` over some range returns, its points, its coverage or its
misses, may have changed, whichever tab caused it. It carries ranges, never data, in milliseconds on the
grid, ascending and disjoint:

- `written`: the slots a call wrote, a put's range or its batch's span, a fetch's range, a hydrate's
  applied parts, the forming bar included. They are the slots the call touched, whether or not a value
  differed.
- `removed`: coverage the call withdrew, by `invalidate` or a watermark moved back; the points may still
  be there. Only coverage that was there is listed: an `invalidate` over nothing sends no event.
- `cleared`: everything the cache held went (`clear`, `clearAll`, a new dataset version). `removed` is
  then empty, and `written` lists what the same call wrote after the clear.
- `requestId`: the call that made the change, or for a fetch the `get` that started it.

One event is sent per call that changed the cache, before that call resolves: a put's event arrives
before the put's promise settles. For one call the order is `cacheCleared` (when it cleared), then
`cacheChanged`, then any `mergeWarning`. Nothing is sent for reads, `cacheOnly` reads, `snapshot`,
`updateAuth`, a failed fetch, a watermark moved forward, or a cache's load from disk.

`client.on('cacheChanged', fn)` hears every cache, `cache.on('cacheChanged', fn)` its own. The first
listener subscribes the client in the worker and the last one's unsubscribe ends it, so a page that
does not listen costs the worker nothing. Subscribe, then read: a change after the subscription is
either in the read or reported after it.

### Reading after an event

Read the range you show again, by this rule:

- The event wrote something, and a written or removed range overlaps your range, or `cleared` is set:
  read it with `get(range, { cacheOnly: true })`. What was written is already in the cache.
- The event wrote nothing, and `cleared` is set or a removed range overlaps your range: read it with a
  fetching `get`, to fill what was withdrawn.
- Otherwise: nothing.

Do not fetch on every event. A fetching read over a provisional tail always fetches it, the fetch's
write sends an event, and that event's fetch starts the next one: two tabs following a live tail would
fetch forever. Under the rule, no event a fetch caused starts a fetch. The cost: after a fetch brings a
new dataset version, other tabs show misses outside the range that fetch wrote until their next ordinary
read. Coalesce bursts, for example one read per animation frame, as the
[integrations](https://github.com/anishbenji/tscache/blob/main/integrations/shared/changes.ts) do.

### Hostings and older workers

With a SharedWorker a change in any tab reaches every listening tab of the origin. A dedicated worker
or the in-process hosting has a cache per tab, so a tab hears only its own changes. A worker script
from before change events (a stale cached script during a deploy) never sends one: `client.features`
then lacks `'cacheChanged'`, the listener is never called, and a development build warns once. Check
`client.features.has('cacheChanged')` and poll where it is missing.

## Request ids

A request-scoped event carries the `requestId` of the call that caused it, `'<clientId>:<seq>'`. The
worker assigns each connection its `clientId`, so ids are unique across tabs, and a tab that hears a
broadcast can tell which tab's request caused it. A `mergeWarning` caused by an orchestrated fetch names
the `get` that started the fetch.

## Overlap warnings

`warnOnOverlapDiff` is off by default, because comparing costs time proportional to the overlap. With it
on, a write whose values differ from the stored ones at slots the cache already held reports each run of
differing points as `{ range, fields }`. The call that wrote them gets the warnings directly in its
result, `put()`'s `{ warnings }`, and every tab hears `mergeWarning`. Values are compared after
conversion to the field's dtype; `NaN` equals `NaN`. Differences in the provisional tail are not
reported, since that data is expected to change.

## Examples

<<< @/snippets/client.ts#fallback{ts}

<<< @/snippets/cache.ts#events{ts}

<<< @/snippets/cache.ts#changes{ts}

`authInvalid` and `workerLost` are covered in [Credentials and refresh](/guides/auth) and
[Workers and fallback](/guides/workers).
