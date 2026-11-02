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

## What is stored, and when

- The covered ranges below the finalized watermark, and the points inside them. The provisional tail
  ([Versions and watermarks](/concepts/freshness)) is never stored, so a reload fetches it again.
- Additions are written behind: about a second after the last change, and at most five seconds after the
  first. A live tail that only rewrites provisional points writes nothing.
- A removal (`invalidate`, `clear`, a watermark moved back, a version change, `clearAll`) is written at
  once, and the call that made it resolves only once it is durable, or once persistence of the cache has
  stopped and its records were deleted. Such a call takes at most about ten seconds on a failing disk.
- When the last tab closes, the worker writes what was still waiting.

## Loading

`cache()` of a persisted cache resolves once its records are loaded and applied, so the first `get`
through the handle sees them; on a stalled disk it waits at most five seconds. A second tab opening the
same cache waits for the same load. A range the records do not cover, an evicted one included, reads as
uncached and is fetched; it never reads as a confirmed gap. Records written under another structure or
another `version` are not loaded, and the cache writes its own over them.

## Failures

A persistence failure never rejects a call. The cache stops persisting, its records are deleted, and every
tab hears `persistStopped` with `reason` `'unavailable'` (the database cannot be opened, or a write or the
load did not finish in time) or `'error'` (a write or the load failed, with the error); the cache goes on in
memory. (`'quota-exceeded'` is reserved for a later release; an exceeded quota is reported today as
`'error'` with the `QuotaExceededError`.) A stop while `cache()` loads is emitted before the handle
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
until it ends.

A client hosted in a dedicated worker or in-process persists nothing, but its `clearAll` empties the
database too, so a logout from any page removes what a SharedWorker session stored. It loads the
clearing code only then, and creates no database where there is none, except in a browser without
`indexedDB.databases()` (Firefox before 126), where it cannot tell and leaves an empty database behind.
It cannot reach the memory of
a SharedWorker that other tabs still use: that worker writes back what it changes, so to clear it as
well, call `clearAll` from one of its tabs. When the clear fails (IndexedDB unavailable, or refusing the
clear for five seconds), the call still resolves, nothing else changes, and the next `clearAll` tries
again.
