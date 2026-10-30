# Events

Events come in three scopes over one channel. Subscribe with `client.on(event, fn)`, which hears every
event of that type, or with `cache.on(event, fn)`, which hears the cache- and request-scoped events of
that cache only. Both return the unsubscribe function; `client.off(event, fn)` also works. Listeners run
on the page; one that throws does not stop the others.

| Event | Scope | Payload | When |
|---|---|---|---|
| `authInvalid` | client | `{ error: { name, message }, context }` | the fetcher threw `AuthInvalidError`; sent to every tab, with the fetcher context the refused fetch was issued with |
| `modeFallback` | client | `{ from, to, reason }` | a hosting failed while connecting and the chain stepped down |
| `workerLost` | client | `{ reason }` | the worker behind this client is gone; at most once per client, never after `dispose()` |
| `cacheCleared` | cache | `{ cacheId, reason }` | the cache was emptied: `'manual'`, `'clear-all'` or `'version-mismatch'` |
| `mergeWarning` | request | `{ cacheId, requestId, range, fields }` | with `warnOnOverlapDiff`, a write changed values the cache already held outside the volatile region |

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

`authInvalid` and `workerLost` are covered in [Credentials and refresh](/guides/auth) and
[Workers and fallback](/guides/workers).
