# Consumer patterns

Things tscache deliberately leaves to the application, and the limits an application has to design
around. The API itself is in [`docs/architecture.md`](../architecture.md) §2; worker and bundler setup is
in [`worker-setup.md`](worker-setup.md); framework wiring is in [`integrations/`](../../integrations).

## Expiry on your own clock (no TTL)

tscache has no time-to-live. Most of what it caches is history that never changes, where an expiry would
only cause refetches; the parts that do change have better tools:

- **A live tail** (the current candle, the last minutes of a metric): report `meta.finalizedUntil` from the
  fetcher. Points at or after the watermark are provisional, never covered, and fetched again by every
  `get` that includes them.
- **A known correction**: `invalidate(range)` forgets the coverage of the range; the next `get` fetches it
  again and replaces the points (N11). Until then the old points stay readable (N16), so a chart does not
  go blank.
- **A schedule** (a nightly batch rewrites yesterday, a session ends): call `invalidate` or `clear` on your
  own clock.

```ts
import type { CacheHandle } from "@anishbenji/tscache";

// A one-minute series whose previous UTC day a batch rewrites at 02:00:
// once the batch has run, forget that day, and the next get fetches it.
const DAY = 86_400_000;
const MINUTE = 60_000;
function forgetYesterday(cache: CacheHandle): Promise<void> {
  const today = Math.floor(Date.now() / DAY) * DAY;
  return cache.invalidate({ start: today - DAY, end: today - MINUTE });
}
```

With a SharedWorker one tab's timer serves every tab, since they read the same cache; with dedicated
workers (a browser without SharedWorker, such as Samsung Internet) each tab runs its own.

## Restatements need a version

If the backend changes a point the cache already covers and says nothing, no library mechanism can
notice: the cache keeps returning the old value until you `invalidate` the range or `clear` the cache.
Report a dataset `version` from the fetcher (`meta.version`) when the backend has one; a change clears the
cache and emits `cacheCleared` with reason `'version-mismatch'` (architecture §2.4).

## Integer fields cannot be missing

Presence is recorded per point, not per field: a point either exists with every field, or does not
exist. A float field can mark one missing value with `NaN`; an integer field (`i32`, `u8`, ...) has no
such value, so a point that exists stores a number in it. A put rejects any value that is not a number
(`null` and `undefined` included) and, for an integer field, `NaN`, `±Infinity` and values outside the
dtype's range, with `PutError` `'field-mismatch'` (architecture N68). JSON has no `NaN`, so a fetcher
that reads JSON maps each missing value (`null`) to `NaN` for a float field. If a field can be missing on
its own:

- store it as `f32` or `f64` and write `NaN` for missing (exact for integers up to 2^24 and 2^53), or
- keep a separate cache for it, so its absence is a missing point there.

Nothing is coerced. A fraction for an integer field is rejected (`1.5` for an `i32` field; architecture
N68, decision 38), as is a `null` a fetcher did not map to `NaN`: the response is rejected and the range
reported `'fetch-failed'`. Round in the fetcher if the backend sends fractions for an integer field. The rules are in `site/concepts/grid.md` ("Batches").

`examples/solid-uplot` shows the problem with a sensor's integer field. Per-field presence masks are on
the [roadmap](../roadmap.md).

## `clear` reaches every tab

With a SharedWorker every same-origin tab reads the same caches. `cache.clear()` and `client.clearAll()`
empty them for all tabs, and every tab hears `cacheCleared`. Use them for resets that should apply
everywhere (a logout, a version change you detected yourself), not for one view's housekeeping; to
refetch a range for one view, `invalidate` it. In a browser without SharedWorker (Samsung Internet, for
example), each tab has its own dedicated worker and a clear stays in that tab.

## Credentials

Cookie-based authentication needs no tscache code: cookies go with the worker's fetches.

With tokens, the fetcher receives them in its `context`, throws `AuthInvalidError` (from
`@anishbenji/tscache/fetcher`) when the backend refuses one, and every tab hears `authInvalid` with the refused
context (design (b), architecture §6.2, N33). That holds with a SharedWorker. With dedicated workers each tab has its own worker, and in-process
(no worker) each client has its own engine, each with its own credential state, so `authInvalid`
reaches only the tab whose fetch was refused and `updateAuth` restores only that tab's worker, or that
client's engine. The other tabs hear their own
`authInvalid` when the backend refuses them, and the Web Locks snippet below still converges tab by tab. Any tab may refresh and call `updateAuth`, after which the
next `get` fetches again; nothing is paused or retried for a `get` that already returned. Refreshing with a rotating refresh token needs one tab at a time; the Web Locks
snippet in [`examples/react-lwcharts/src/auth-refresh.ts`](../../examples/react-lwcharts/src/auth-refresh.ts)
does it, and its header lists what it assumes. The main assumption is that a refresh issues a new access
token: a tab that takes the lock after another tab's refresh compares the stored access token with the
refused one. A backend that renews an access token in place returns the same string, so each tab that
heard the refusal refreshes once in turn, always with the current refresh token (architecture N42). The
session survives; the cost is one redundant refresh per extra tab. While credentials are invalid, `get`
does not wait: the affected ranges come back as misses with reason `'auth-pending'`, and a `get` after
`updateAuth` fills them.

## Bound every request

The worker never cancels a fetch. A `get` whose range overlaps fetches already in flight for the cache,
from any tab, waits for them and fetches only the rest, so a request that never settles holds every `get`
that needs one of its slots (architecture §4.9.1, N65). Bound each request in the fetcher and throw when the
bound passes, for example with `fetch(url, { signal: AbortSignal.timeout(10_000) })`. The error comes back
as a `'fetch-failed'` miss for the gets that waited on it, and the next `get` tries again.

## A lost worker

Chromium runs a SharedWorker in the process of the tab that created it; if that tab crashes, the worker
goes with it and every other tab's client emits `workerLost` once. Create a new client to go on.
[`integrations/shared/connection.ts`](../../integrations/shared/connection.ts) does this for every
framework, and [`worker-setup.md`](worker-setup.md) shows the bare pattern.

## Persistence across sessions

A cache created with `persist: true` keeps its covered history in IndexedDB, so a reload or a new tab
starts from what earlier sessions fetched, and immutable history is fetched once per device instead of
once per session (architecture §4.10). It is off by default and set per cache, and it is structural:
every tab must pass the same value.

```ts
const candles = await client.cache({
  id: "candles/ACME/1m",
  interval: 60_000,
  fields: { open: "f64", high: "f64", low: "f64", close: "f64", volume: "f64" },
  version: "2026-10", // stored records of another version are never loaded
  persist: true,
});
```

- **Where it acts.** Only the SharedWorker hosting persists: one worker then owns its origin's database
  and is its only writer. In the dedicated-worker and in-process hostings (a browser without
  `SharedWorker`, a fallback, or a pinned `mode`), in Node and for an `Engine` used directly, the flag is
  accepted and does nothing, without an event. `client.mode === 'shared'` in a browser with IndexedDB
  tells you that the cache persists.
- **What is stored.** The covered ranges below the finalized watermark and the points inside them,
  written behind about a second after the last change (at most five seconds). The provisional tail is
  never stored, so a reload fetches it again. A removal (`invalidate`, `clear`, a watermark moved back, a
  version change) is written at once, and its call resolves only once the removal is durable, or once
  persistence of the cache has stopped and its records were deleted.
- **Loading.** `cache()` of a persisted cache resolves once its records are loaded (at most five seconds),
  so the first `get` sees them. A range the records do not cover reads as uncached, never as a gap.
- **Failures never reject.** When the disk refuses, persistence of that cache stops, its records are
  deleted, and every tab hears `persistStopped` with the reason (`'quota-exceeded'` at once when the
  origin's quota is full); the cache goes on in memory. A stop
  during `cache()` comes before the handle exists, so listen with `client.on`.
- **Restatements need a version, across sessions too.** A stored range is served in every later session
  without asking the backend. Set `version` when the dataset has one: records of another version are
  never loaded. Without one, `invalidate` or `clear` on your own clock removes stored ranges as well.
- **Durable storage is your call.** Browsers evict best-effort storage under pressure, and a range whose
  record was evicted is simply fetched again. To keep the cache, call `navigator.storage.persist()` from
  the page; tscache never does, since some browsers prompt the user.
- **Sensitive data.** The records are readable by every script of the origin and outlive the session.
  Keep per-user or sensitive caches in memory; that is why `persist` is per cache.
- **Logout.** One `client.clearAll()` from a tab of the SharedWorker empties every cache and the database,
  and resolves once the records are gone (or persistence has stopped). It does not reach the records of
  another deploy's worker that is still running (the next clear or that worker's end removes them).
  A client hosted in a dedicated worker or in-process persists nothing, but its `clearAll` empties the
  database too, so a logout from any page removes what a SharedWorker session stored. It cannot reach
  the memory of a SharedWorker other tabs still use, which writes back what it changes; to clear that
  worker as well, call `clearAll` from one of its tabs. When the clear fails (IndexedDB unavailable or
  refusing it for five seconds), the call still resolves, and the next `clearAll` tries again.
