# Troubleshooting and FAQ

## `client.mode` is `'in-process'`, and tabs do not share

Both workers failed to start, usually because `workerUrl` does not resolve to the served worker script.
Listen for `modeFallback`, whose `reason` says why each hosting failed. With webpack, a bare
`new URL("@anishbenji/tscache/worker", import.meta.url)` emits the entry without its chunks; serve `dist/` instead
([Workers and fallback](/guides/workers)).

## `client.mode` is `'dedicated'`

Expected in a browser without `SharedWorker`, such as Samsung Internet or Chrome for Android before
version 148 ([browser support](/guides/workers#browser-support)). Elsewhere, the SharedWorker failed, did
not say hello within `handshakeTimeoutMs`, or stopped running during the handshake ("SharedWorker
stopped running during the handshake"); `modeFallback` says which.

## `createClient` rejects with `ProtocolMismatchError`

The worker script at your worker URL is from another version of tscache than the page: one served from
an old HTTP cache entry, or one replaced at a fixed URL under a page that is still open. Reload the
page with the HTTP cache revalidated, and serve the worker script with revalidation or under a hashed
URL. Retrying with `mode: 'dedicated'` does not help: a dedicated worker loads the same script. A
running worker of an older deploy no longer causes this, since from 0.3.0 a newer tab starts a worker
of its own ([Stale scripts after a deploy](/guides/workers#stale-scripts-after-a-deploy)).

## `createClient` rejects with `this worker already runs fetcher`

A `ConfigError` whose `code` is `'fetcher-conflict'`: the worker already runs another fetcher module,
and a worker runs one. From 0.3.0 a deploy that changes the fetcher's URL no longer does this, because
the fetcher URL is part of the SharedWorker's name and the newer tab gets a worker of its own. It
remains for a page of 0.2.0 that reaches a later release's worker script at a fixed URL: reload that
page ([A stale worker script](/guides/workers#a-stale-worker-script)). Recognise the error by its
`code`, not by its message.

## A tab hears `superseded`, or `persistStopped` with `'superseded'`

A newer deploy's tab is open in the same browser, and its worker has taken over the database. The tab
that heard the event keeps working from memory and its own fetcher, and persists nothing more. Prompt
the user to reload ([Stale scripts after a deploy](/guides/workers#older-tabs-are-told-superseded)).
If it recurs after every reload, pages of your deploy pass different fetcher URLs for different
modules, or a stale page is being served: check that every page passes the same `fetcher.module`.

## `createClient` rejects naming the fetcher module

The worker could not `import()` it, or its default export has no `fetch` function. With Vite, import it
with `?fetcher`, not `?worker&url`, which drops the exports. A relative URL resolves against the worker
script, not the page: pass an absolute path.
If the message says `Cannot find module` and your build is not Vite, a bundler rewrote the import:
check that nothing strips the `/* webpackIgnore: true */` comment from tscache's code (see
[webpack 5 and Rspack](/guides/workers#webpack-5-and-rspack)).

## `createClient` never settles

The fetcher module's `import()` has not settled: its server accepted the request and never answered, or
a top-level `await` in the module, or in code it imports, never resolves. `handshakeTimeoutMs` bounds only
the wait for the worker's hello, and in 0.2.0 nothing bounds the load after it. Check the module's
request in the network panel of the worker's devtools, and move long work out of the module's top level.

## A fetch fails with `ReferenceError: document is not defined`

The fetcher, or code it imports, uses `import()`, and a bundler wrapped it in a preload helper that
needs the DOM. `fetcherUrl()` fails the build for this; import statically or
[build the fetcher on its own](/guides/vite#a-fetcher-that-needs-import).

## `put` rejects with `PutError` `'misaligned'`

A timestamp is not on the cache's grid. `expected` shows the grid, e.g. `"t ≡ 0 (mod 60000)"`. Check
`interval` and `alignmentOffset`, and that timestamps are milliseconds, not seconds.

With a [calendar interval](/concepts/grid#calendar-intervals), `expected` names the calendar, e.g.
`"the start of a day in America/New_York at 09:30"`. Check that each bar is stamped at the instant the
zone's clock reads `at`, which moves in UTC when the zone changes its clocks, and that the zone and
`at` are the backend's.

## `cache()` rejects a calendar interval with `ConfigError`

The message names the field: an unknown `unit`, a `zone` the runtime does not know, an `at` that is not
`HH:MM`, a `weekStart` outside a week, or an `alignmentOffset` other than 0. If it names the
`'calendar-grid'` feature instead, the page's worker runs a version of the library from before calendar
intervals, typically a cached worker script during a deploy: `client.features.has("calendar-grid")`
tells you beforehand.

## `cache()` rejects with `ConfigError` in one tab

Another tab created the cache with another structure (interval, offset, fields, `gapSplitK`,
`segmentSlotCap` or `warnOnOverlapDiff`). Every tab must open a cache id with the same structure; a
deploy that changes it needs a new id.

## Data I pushed disappeared

A write with a range replaces it: a later fetch, or a `put` with `options.range`, removes the points it
does not carry. Pushed bars past the watermark stay provisional and are replaced by the next fetch over
them, which is the point. A `cacheCleared` event with reason `'version-mismatch'` means a response
reported another dataset version.

## A range is never fetched again, though the backend has data there now

The cache holds it as a confirmed gap: a response once came back without points there. If the backend
publishes late, the fetcher must report `meta.finalizedUntil` ([Writing a fetcher](/guides/fetcher)).
To recover now, `invalidate` the range.

## Corrected history does not show

Restatements without a version are undetectable. Report `meta.version`, or `invalidate` the range
([Versions and watermarks](/concepts/freshness)).

## A read returns misses with `'auth-pending'`

Credentials are invalid. Some tab must refresh and call `updateAuth`; then read again
([Credentials and refresh](/guides/auth)).

## My typed arrays are empty after `put`

They were transferred to the worker and are detached. Pass copies if you still need them.

## Calls reject after a tab crashed

The SharedWorker died with the tab that hosted it, and `workerLost` fired. Create a new client; the
integrations' `connect` does it for you. Outside a secure context, loss is not detected and calls hang.

## Does tscache cache across page loads?

Only when you ask for it: a cache created with `persist: true` keeps its covered history in IndexedDB,
so a reload starts from what earlier sessions fetched ([persistence](/guides/persistence)). Only the
SharedWorker hosting persists; otherwise everything stays in memory. Server rendering can
[seed](/guides/ssr) a new page's cache.

## Does it work in Node?

Yes, with `mode: 'in-process'` or `Engine` from `@anishbenji/tscache/engine`. There is no `worker_threads` hosting.

## Can two origins share a cache?

No: workers are same-origin, and a `SharedWorker` is shared only among same-origin tabs.
