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
import type { CacheHandle } from "tscache";

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
workers (Chrome for Android) each tab runs its own.

## Restatements need a version

If the backend changes a point the cache already covers and says nothing, no library mechanism can
notice: the cache keeps returning the old value until you `invalidate` the range or `clear` the cache.
Report a dataset `version` from the fetcher (`meta.version`) when the backend has one; a change clears the
cache and emits `cacheCleared` with reason `'version-mismatch'` (architecture §2.4).

## Integer fields cannot be missing

Presence is recorded per point, not per field: a point either exists with every field, or does not
exist. A float field can mark one missing value with `NaN`; an integer field (`i32`, `u8`, ...) has no
such value, so a point that exists stores a number in it. If a field can be missing on its own:

- store it as `f32` or `f64` and write `NaN` for missing (exact for integers up to 2^24 and 2^53), or
- keep a separate cache for it, so its absence is a missing point there.

`examples/solid-uplot` shows the problem with a sensor's integer field. Per-field presence masks are on
the [roadmap](../roadmap.md).

## `clear` reaches every tab

With a SharedWorker every same-origin tab reads the same caches. `cache.clear()` and `client.clearAll()`
empty them for all tabs, and every tab hears `cacheCleared`. Use them for resets that should apply
everywhere (a logout, a version change you detected yourself), not for one view's housekeeping; to
refetch a range for one view, `invalidate` it. On Chrome for Android, which has no SharedWorker, each tab
has its own dedicated worker and a clear stays in that tab.

## Credentials

Cookie-based authentication needs no tscache code: cookies go with the worker's fetches.

With tokens, the fetcher receives them in its `context`, throws `AuthInvalidError` (from
`tscache/fetcher`) when the backend refuses one, and every tab hears `authInvalid` with the refused
context (design (b), architecture §6.2, N33). Any tab may refresh and call `updateAuth`, after which the
paused fetches run again. Refreshing with a rotating refresh token needs one tab at a time; the Web Locks
snippet in [`examples/react-lwcharts/src/auth-refresh.ts`](../../examples/react-lwcharts/src/auth-refresh.ts)
does it, and its header lists what it assumes. While credentials are invalid, `get` does not wait: the
affected ranges come back as misses with reason `'auth-pending'`, and a `get` after `updateAuth` fills
them.

## A lost worker

Chromium runs a SharedWorker in the process of the tab that created it; if that tab crashes, the worker
goes with it and every other tab's client emits `workerLost` once. Create a new client to go on.
[`integrations/shared/connection.ts`](../../integrations/shared/connection.ts) does this for every
framework, and [`worker-setup.md`](worker-setup.md) shows the bare pattern.
