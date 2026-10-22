# Roadmap

Work deliberately left out of v1, with design sketches where a design exists. A sketch records the
direction and the constraints the v1 design already protects; each still needs its decision points
settled with the user before it is built, as every step of the commit plan did.

## Reference clients (requested 2026-10-22)

Three reference clients that show how to use tscache in an application, one each for **vanilla
JavaScript**, **React** and **Solid**. Each covers the whole client lifecycle: connect once, replace the
client on `workerLost`, dispose on teardown; read with `get` and render coverage and misses; `put` pushed
data; refresh credentials through `authInvalid` and `updateAuth`; and hydrate from a server render. The
bar is the one the examples set, raised to reference quality: best practices for each platform, high
performance, idiomatic code, and clean, clear code a reader can copy as it stands.

**Shape (user decision, 2026-10-22): tested source to copy, not packages.** They grow out of the step ⑭
integration snippets (`integrations/`), whose framework-neutral core (`integrations/shared/`) already
holds the lifecycle and the hydration, and add what a snippet leaves out: the auth refresh, pushed data,
a chart, and tests that run each one. Nothing is published, so the one-package rule (starter §5) is
untouched and no adapter API needs versioning; the library's framework surface (lifecycle, then
promise to reactivity) is small enough for an application to own. Subpath adapters with optional peers
(`tscache/react`, `tscache/solid`) stay possible later if copying proves a burden.

## Design sketch: IndexedDB persistence

**Goal.** A reload or a new tab starts from what an earlier session fetched. Immutable history, the
primary use (N11), is then fetched once per device rather than once per session.

**The unit stored is the page.** Segments never cross a multiple of `segmentSlotCap` (N15), so a page
(slot index divided by the cap) is a stable key while the segments inside it split and merge. One record
per `[cacheId, page]` holds the page's segment payloads in the §3.4 format, unchanged: the "one format,
three uses" invariant is what makes this cheap. A page that is covered but holds no point is stored as a
record with no segments, so a confirmed gap survives a reload. One record per cache holds the resolved
config, the dataset `version`, the watermark, the coverage and the payload `format`.

**Write-behind only.** A merge marks its pages dirty; a flush writes the dirty pages and the cache record
in one IndexedDB transaction, so coverage and data on disk always agree. Flushes are debounced (about a
second of quiet). A worker sees no `pagehide`; the client's dispose message on `pagehide` (§4.8) is the
trigger for a final flush when the last tab leaves. A crash loses at most the debounce window, which is
harmless: what was not written is not covered on disk either.

**The volatile region stays in memory.** Only points below `finalizedUntil` are written; coverage never
includes the volatile region anyway. After a reload the provisional tail is fetched again, as it would be
in a running session.

**Loading reconciles coverage with what is present.** A cache record whose `format` is unknown, whose
structural config differs (the N20 fields) or whose `version` differs from the configured one is
discarded with its pages. Otherwise the coverage is loaded, and any covered range whose page record is
missing (an interrupted write, a partial clear) is subtracted from it, so a lost page reads as uncached,
never as a confirmed gap. Browsers evict best-effort storage for a whole origin at once, which the same
rule handles.

**One writer per page at a time.** In a SharedWorker one engine owns the database. With dedicated workers
(Chrome on Android) and in-process clients each tab has its own engine, so a flush takes a Web Lock per
database and merges under it: it reads the stored page and cache record, unions the coverage and merges
the points new-wins, then writes. Without the read-merge-write, one tab's flush would erase coverage
another tab had written.

**Clearing.** `clear`, `clearAll` and a version-mismatch clear delete the cache's records in the next
flush; `invalidate` reaches disk through the cache record's coverage. Logging out on a shared device is a
`clearAll`, which therefore also empties the disk.

**Decision points to settle before building.** Opt-in per cache (`CacheConfig.persist`, a structural
field under N20, so per-user caches can stay in memory) or per client; loading every page when a cache
opens or pages lazily on first read (lazy keeps start-up flat but puts an asynchronous step inside the
read path); what happens when the quota is exceeded (proposed: stop persisting that cache and emit an
event); whether to request `navigator.storage.persist()`. The SSR snapshot API below would serialise the
same page records, so the two should be designed together.

## Design sketch: subscriptions (dirty notifications)

A cache-scoped event, `cacheChanged { cacheId, range }`, emitted after any merge, invalidation or clear
with the range it touched. It carries no data: every tab would otherwise receive a copy of every merge.
A consumer whose shown range overlaps calls `get` again, and the in-flight dedup keeps the fan-out to one
fetch. Changes are coalesced per cache and macrotask. The event fits the cache scope of §2.7 unchanged,
and an integration's series would subscribe for live charts across tabs without polling.

## Design sketch: eviction and memory limits

A byte budget per worker, enforced by evicting least-recently-read pages. The invariant that makes it
safe: evicting a page subtracts the page's extent from coverage. Otherwise its points would read as a
confirmed gap that is never refetched, the one way eviction could corrupt answers. With persistence, an
evicted page stays on disk and is loaded again on demand, which needs the lazy loading path above.

## Deferred features (starter §10)

- Aggregation and resampling across intervals, likely with user-defined rules per dataset. Today a series
  at 1 m and at 1 h are two caches.
- `ColumnarSegment` for sparse data (explicit timestamps, no mask), and a third segment layout for
  irregular timestamps. The payload's `layout` field already admits them.
- SharedArrayBuffer as an opt-in (it needs COOP/COEP headers).
- Per-field presence masks, so integer fields can represent a missing value; the self-describing payload
  leaves room for them.
- An elected auth handler, design (c) in architecture §6.2.
- Node `worker_threads` hosting.

## Deferred decisions (architecture §8)

- **N28.** A heartbeat so the SharedWorker can drop a tab that died without `pagehide`, if real tab churn
  shows the bounded leak matters.
- **N31.** Subtracting in-flight ranges from new fetch requests, instead of sharing only identical ranges.

## For the post-build architecture review

- A snapshot API over the segment payload (§3.4) that carries the dataset version and watermark, so SSR
  hydration is exact and a seed can no longer outlive a restatement (`docs/reviews/step-13.md`, ⑬b),
  applied in one engine step only where the browser's cache covers nothing, so another tab's fetch
  cannot land between the check and the put (`docs/reviews/step-14.md`, R2-2).
- A `tscache/vite` entry for the two Vite plugins the examples needed: the fetcher URL, with file URLs for
  server builds, and the SSR page plugin.
- DC-1 and DC-2 from step ⑫ (`docs/reviews/step-12.md`): the refresh snippet's assumption that a refresh
  issues a new access token, and the two ways a client can stop being served that N32 does not detect.
