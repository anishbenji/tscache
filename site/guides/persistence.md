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
- A removal (`invalidate`, `clear`, a watermark moved back, a version change) is written at once, and the
  call that made it resolves only once it is durable, or once persistence of the cache has stopped (what
  each stop does with the records, `'superseded'` included, is under [Failures](#failures)). `clearAll()`
  empties the disk and resolves once that clear has settled: use it to remove data from the disk. Either call takes at most about ten seconds on
  a failing disk.
- When the last tab closes, the worker writes what was still waiting. Where the browser supports it
  (Chromium), tscache creates the worker with `extendedLifetime`, which keeps it running about 30 seconds
  after its last tab so that write can land. Elsewhere the option is ignored, and a worker that ends
  first loses the additions still waiting, at most five seconds of them; the disk keeps the earlier state.
  A removal is not exposed to this, since its call waits for the disk as above.

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

A persistence failure never rejects a call. The cache stops persisting, its records are deleted, and every
tab hears `persistStopped` with `reason` `'quota-exceeded'` (the origin's storage quota is full: the cache
stops at the first refused write, without retrying, with the `QuotaExceededError`), `'unavailable'` (the
database cannot be opened, or a write or the load did not finish in time) or `'error'` (a write or the load
failed, with the error); the cache goes on in memory. A stop while `cache()` loads is emitted before the
handle exists, so listen on the client:

<<< @/snippets/persistence.ts#stopped{ts}

A fourth reason, `'superseded'`, is not a failure: a newer deploy's worker is running in the origin and
owns the records now ([Stale scripts after a deploy](/guides/workers#older-tabs-are-told-superseded)).
The older worker stops writing, for every persisted cache at once, and deletes nothing of its own
accord; a cache it opens later loads nothing. Its `invalidate`, `clear` and other removals resolve at
once and leave the records, while `clearAll()` still empties the disk and resolves once that clear has
settled. Its tabs keep working from memory until they are reloaded.

## Versions across sessions

A stored range is served in every later session without asking the backend, so a restatement the backend
does not announce lasts across reloads too. Set `version` when the dataset has one: records of another
version are never loaded. Without one, `invalidate` or `clear` on your own clock removes stored ranges as
well ([Expiry and other patterns](/guides/patterns)), except in a tab whose worker is superseded
([Failures](#failures)): there the records stay, for the newer worker to load, and only `clearAll()`
removes them.

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

From 0.3.0 it reaches every SharedWorker of the origin, an older deploy's that other tabs still use
included: each clears its memory and the disk too, so none of them writes the data back. The promise
resolves when the calling worker's own clear is done and does not wait for the others. A worker of
tscache 0.1.0 or 0.2.0 is not reached and writes back what it still holds. If a `clearAll` cannot empty
the disk within five seconds, every persisted cache stops, and that worker persists nothing more until
it ends.

A client hosted in a dedicated worker or in-process persists nothing, but its `clearAll` empties the
database too, so a logout from any page removes what a SharedWorker session stored. It loads the
clearing code only then, and creates no database where there is none, except in a browser without
`indexedDB.databases()` (Firefox before 126), where it cannot tell and leaves an empty database behind.
From 0.3.0 its `clearAll` reaches the SharedWorkers that other tabs still use as well, which clear
their memory and so write nothing back. When the clear fails (IndexedDB unavailable, or refusing the
clear for five seconds), the call still resolves, nothing else changes, and the next `clearAll` tries
again.
