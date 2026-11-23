# Persistence

A cache created with `persist: true` keeps its covered history in IndexedDB, so a reload or a new tab
starts from what earlier sessions fetched: history that never changes is fetched once per device instead
of once per session. It is off by default, set per cache, and structural: every tab must pass the same
value. The design is §4.10 of the
[architecture](https://github.com/anishbenji/tscache/blob/main/docs/architecture.md).

<<< @/snippets/persistence.ts#opt-in{ts}

## Where it acts

Only the **SharedWorker** hosting persists: every tab of the origin reaches one worker, whose engine is
then the only writer of the database. In the dedicated-worker and in-process hostings (a browser without
`SharedWorker`, a [fallback](/guides/workers), or a pinned `mode`), in Node and for an `Engine` used
directly, `persist: true` is accepted and does nothing, without an event. `client.mode === 'shared'` in a
browser with IndexedDB tells you that the cache persists.

::: warning A page that fell back persists nothing
A page whose SharedWorker failed (a browser without it, a script that did not load, a worker that did
not answer in time) runs a dedicated worker or in-process, and its caches stay in memory: a reload
fetches everything again. Nothing reports it except `client.mode`, which is then `'dedicated'` or
`'in-process'`, and the `modeFallback` events, which are emitted once, just after `createClient`
resolves, to the listeners attached by then. Check `client.mode` if persistence matters to you.
:::

## What is stored, and when

- The covered ranges below the finalized watermark, and the points inside them. The provisional tail
  ([Versions and watermarks](/concepts/freshness)) is never stored, so a reload fetches it again.
- Additions are written behind: about a second after the last change, and at most five seconds after the
  first. A live tail that only rewrites provisional points writes nothing.
- A removal (`invalidate`, `clear`, a watermark moved back, a version change, `clearAll`) is written at
  once, and the call that made it resolves only once it is durable, or once persistence of the cache has
  stopped and its records were deleted. Such a call takes at most about ten seconds on a failing disk.
- When the last tab closes, the worker writes what was still waiting. Where the browser supports it
  (Chromium), tscache creates the worker with `extendedLifetime`, which keeps it running about 30 seconds
  after its last tab so that write can land. Elsewhere the option is ignored, and a worker that ends
  first loses the additions still waiting, at most five seconds of them; the disk keeps the earlier state.
  A removal is not exposed to this, since its call resolves only once it is durable.

## Loading

`cache()` of a persisted cache resolves once its records are loaded and applied, so the first `get`
through the handle sees them; on a stalled disk it waits at most five seconds. A second tab opening the
same cache waits for the same load. A range the records do not cover, an evicted one included, reads as
uncached and is fetched; it never reads as a confirmed gap.

With a memory budget ([Memory](/guides/patterns#memory)), a page the worker evicts leaves the disk too:
the next write-behind flush deletes its record, so the stored records never hold more than memory did,
and the next session's load stays within what the budget let the worker hold. An evicted range is
therefore fetched again from the backend, in this session and the next. A load larger than the budget
keeps only its newest pages. Ranges that are covered but hold no bar (confirmed gaps) cost no memory, are
never evicted and keep their small records. Records written under another structure or
another `version` are not loaded, and the cache writes its own over them.

A cache with a [calendar interval](/concepts/grid#calendar-intervals) in a zone checks its stored
pages as it checks a server's snapshot ([Server rendering](/guides/ssr#calendar-caches)): after a
browser update that changed the zone's rules, a page whose range or coverage ends now fall in other
slots is skipped and fetched again. The five seconds bound the disk read; applying the records comes
after it, and for a very fragmented calendar cache (more than about 14,500 separate coverage ranges)
only the newest pages are applied.

## Failures

A persistence failure never rejects a call. The cache stops persisting and goes on in memory, and every
tab hears `persistStopped` with `reason` `'quota-exceeded'` (the origin's storage quota is full: the cache
stops at the first refused write, without retrying, with the `QuotaExceededError`), `'unavailable'` (the
database cannot be opened, or a write or the load did not finish in time) or `'error'` (a write or the load
failed, with the error). A write that fails for a reason other than quota is retried for about five
seconds, and the cache goes on persisting when a retry succeeds. A write that is refused for quota, or
that still fails after those five seconds, stops the cache and deletes its records, since the disk may still hold what memory removed. A load whose read fails or does not finish in time deletes nothing: the records stay,
and the next session loads them. A database that cannot be opened, or a persistence module that does
not load, stops every persisted cache of the worker the same way. Such a cache keeps its records until
its first later removal (`invalidate`, `clear`, a watermark moved back, a version change, `clearAll`):
that removal deletes them, strict, and its call resolves once the deletion has settled, within about
five seconds. When the deletion fails as well, the records stay. Later removals write nothing. After
the browser closes the database connection, a later load or write stops its cache with `'error'`, and
the records stay, since the deletion fails too. A stop while `cache()` loads is emitted before the handle
exists, so listen on the client:

<<< @/snippets/persistence.ts#stopped{ts}

## Versions across sessions

A stored range is served in every later session without asking the backend, so a restatement the backend
does not announce lasts across reloads too. Set `version` when the dataset has one: records of another
version are never loaded. Without one, `invalidate` or `clear` on your own clock removes stored ranges as
well ([Expiry and other patterns](/guides/patterns)).

## Keeping the storage

Browsers evict best-effort storage under pressure, an origin at a time; an evicted range is fetched again.
To keep the cache, ask for persistent storage from the page. tscache never asks, since some browsers prompt
the user:

<<< @/snippets/persistence.ts#storage{ts}

## Sensitive data and logout

Stored records are readable by every script of the origin and outlive the session. Keep per-user or
sensitive caches in memory; that is why `persist` is per cache. At logout, one `clearAll()` empties
every cache and the database:

<<< @/snippets/persistence.ts#logout{ts}

It does not reach the records a still-running worker of another deploy writes back. If a `clearAll` cannot
empty the disk within five seconds, every persisted cache stops, and that worker persists nothing more
until it ends. When the logout comes while the worker's persistence module is still loading, as on the
worker's first use of persistence or soon after a first `cache()`, the call waits for that loading
first, so it can take up to ten seconds. When the module failed to load, `clearAll` still tries once to
empty the database, within five seconds; when that fails as well, the records stay. In that case only, a
database that opens after the call has answered is still emptied then; with the module loaded, a
database that opens after the five seconds is not emptied.

A client hosted in a dedicated worker or in-process persists nothing, but its `clearAll` empties the
database too, so a logout from any page removes what a SharedWorker session stored. It loads the
clearing code only then, and creates no database where there is none, except in a browser without
`indexedDB.databases()` (Firefox before 126), where it cannot tell and leaves an empty database behind.
It cannot reach the memory of
a SharedWorker that other tabs still use: that worker writes back what it changes, so to clear it as
well, call `clearAll` from one of its tabs. When the clear fails (IndexedDB unavailable, or refusing the
clear for five seconds), the call still resolves, nothing else changes, and the next `clearAll` tries
again.
