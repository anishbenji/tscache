# Events

Events come in three scopes over one channel. Subscribe with `client.on(event, fn)`, which hears every
event of that type, or with `cache.on(event, fn)`, which hears the cache- and request-scoped events of
that cache only. Both return the unsubscribe function; `client.off(event, fn)` also works. Listeners run
on the page; one that throws does not stop the others.

| Event            | Scope   | Payload                                                        | When                                                                                                                                                                                                                                   |
| ---------------- | ------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `authInvalid`    | client  | `{ error: { name, message }, context }`                        | the fetcher threw `AuthInvalidError`; sent to every tab, with the fetcher context the refused fetch was issued with                                                                                                                    |
| `modeFallback`   | client  | `{ from, to, reason }`                                         | a hosting failed while connecting and the chain stepped down                                                                                                                                                                           |
| `workerLost`     | client  | `{ reason }`                                                   | the worker behind this client is gone; at most once per client, never after `dispose()`                                                                                                                                                |
| `superseded`     | client  | `{ lib }`                                                      | a newer deploy's worker runs in the origin, with tscache version `lib`: this tab's worker no longer persists, and a reload joins the newer one; at most once per client ([Workers](/guides/workers#older-tabs-are-told-superseded))    |
| `cacheCleared`   | cache   | `{ cacheId, reason }`                                          | the cache was emptied: `'manual'`, `'clear-all'` or `'version-mismatch'`                                                                                                                                                               |
| `persistStopped` | cache   | `{ cacheId, reason, error? }`                                  | a persisted cache stopped persisting: `'quota-exceeded'`, `'unavailable'` or `'error'` (with the failure), or `'superseded'` (a newer deploy's worker owns the records now); it goes on in memory ([Persistence](/guides/persistence)) |
| `cacheChanged`   | cache   | `{ cacheId, written, removed, cleared, evicted?, requestId? }` | what a read of the cache returns may have changed: a put, a fetch, a hydrate, an invalidate, a moved watermark or a clear ([Change events](#change-events))                                                                            |
| `mergeWarning`   | request | `{ cacheId, requestId, range, fields }`                        | with `warnOnOverlapDiff`, a write changed values the cache already held outside the volatile region                                                                                                                                    |

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
- `evicted`: with a [memory budget](/guides/patterns#memory), coverage the worker evicted to free
  memory. The data did not change, so a view's copy is still right and needs no read. That copy lasts
  until the view's next re-read: a later read from the cache, the `cacheOnly` read after a write
  included, shows the evicted part as `uncached` misses, which the application fetches if it wants
  them; a fetching read fetches it again. Absent when the call evicted nothing. With a budget, a later `invalidate`
  or watermark moved back over an evicted range still lists it in `removed`, so a view that shows it
  hears the change.
- `requestId`: the call that made the change, or for a fetch the `get` that started it. Absent when no
  call of this worker made it: a `clearAll` that reached this worker from another one (below).

One event is sent per call that changed the cache, before that call resolves: a put's event arrives
before the put's promise settles. For one call the order is `cacheCleared` (when it cleared), then
`cacheChanged`, then any `mergeWarning`. Nothing is sent for reads, `cacheOnly` reads, `snapshot`,
`updateAuth`, a failed fetch, a watermark moved forward, or a cache's load from disk.

`client.on('cacheChanged', fn)` hears every cache, `cache.on('cacheChanged', fn)` its own. The first
listener subscribes the client in the worker and the last one's unsubscribe ends it, so a page that
does not listen costs the worker nothing. Subscribe, then read: a change after the subscription is
either in the read or reported after it.

### Reading after an event

Read the range you show again, by this rule. "Your range" is the range as read: snapped outward to the
grid, as `get` snaps it, so a view of 101–199 on a 100 ms grid shows the points at 100 and 200, and a
change there counts.

- The event wrote something, and a written or removed range overlaps your range, or `cleared` is set:
  read it with `get(range, { cacheOnly: true })`. What was written is already in the cache.
- The event wrote nothing, and `cleared` is set or a removed range overlaps your range: read it with a
  fetching `get`, to fill what was withdrawn.
- Otherwise: nothing. An `evicted` range needs no read.

Do not fetch on every event. A fetching read over a provisional tail always fetches it, the fetch's
write sends an event, and that event's fetch starts the next one: two tabs following a live tail would
fetch forever. Under the rule, no event a fetch caused starts a fetch. The cost: after a fetch brings a
new dataset version, other tabs show misses outside the range that fetch wrote until their next ordinary
read. Coalesce bursts, for example one read per animation frame, as the
[integrations](https://github.com/anishbenji/tscache/blob/main/integrations/shared/changes.ts) do.

### A `clearAll` from another worker

From 0.3.0 a `clearAll` reaches every SharedWorker of 0.3.0 or later in the origin (a 0.1.0 or 0.2.0
worker is not reached), whichever tab or hosting called it:
tabs of two deploys have a worker each for a while
([Stale scripts after a deploy](/guides/workers#stale-scripts-after-a-deploy)). A worker that clears
for another worker's call sends its tabs `cacheCleared` with `'clear-all'` and `cacheChanged` with
`cleared: true` and no `requestId`, for every cache, once each time it clears, which can be more than
once for one call. Read again as the rule says: a fetching read. With k other workers running, a worker
clears up to k + 1 times for one `clearAll`, so a view that follows the rule fetches up to k + 1 times
and can show misses in between; the read after the last event fills it. k is 0 while one SharedWorker
runs in the origin. More run while tabs of two deploys that differ in the worker URL, the tscache
version or the fetcher URL are open
([Stale scripts after a deploy](/guides/workers#stale-scripts-after-a-deploy)), or when pages name one
fetcher module by two strings ([One SharedWorker per generation](/guides/workers#one-sharedworker-per-generation)).

### Hostings and older workers

With a SharedWorker a change in any tab reaches every listening tab of that worker. A dedicated worker
or the in-process hosting has a cache per tab, so a tab hears only its own changes. A worker script
from before change events (a stale cached script during a deploy) never sends one: `client.features`
then lacks `'cacheChanged'`, the listener is never called, and a development build warns once. Check
`client.features.has('cacheChanged')` and poll where it is missing.

`superseded` comes only from a SharedWorker, which lists `'superseded'` in `client.features`. A
dedicated worker, the in-process hosting and a worker script from before 0.3.0 do not list it and never
send the event; a listener there is never called, and no warning is printed for it.

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
