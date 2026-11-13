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

The worker script is from another version of tscache: a cached script after a deploy, or a SharedWorker
kept alive by a tab opened before the upgrade. Close the old tabs and reload. A page cannot close the
user's other tabs; until they close, it can create its client again with `mode: 'dedicated'`, a cache
of its own that persists nothing ([Stale scripts after a deploy](/guides/workers#stale-scripts-after-a-deploy)).

## `createClient` rejects with `this worker already runs fetcher`

The running SharedWorker loaded another fetcher module URL, usually a tab from an earlier deploy when the
worker URL is fixed and the fetcher's is hashed. A worker runs one fetcher module; serve the fetcher at a
fixed URL too ([Stale scripts after a deploy](/guides/workers#stale-scripts-after-a-deploy)).

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
the wait for the worker's hello, and in 0.1.0 nothing bounds the load after it. Check the module's
request in the network panel of the worker's devtools, and move long work out of the module's top level.

## A fetch fails with `ReferenceError: document is not defined`

The fetcher, or code it imports, uses `import()`, and a bundler wrapped it in a preload helper that
needs the DOM. `fetcherUrl()` fails the build for this; import statically or
[build the fetcher on its own](/guides/vite#a-fetcher-that-needs-import).

## `put` rejects with `PutError` `'misaligned'`

A timestamp is not on the cache's grid. `expected` shows the grid, e.g. `"t ≡ 0 (mod 60000)"`. Check
`interval` and `alignmentOffset`, and that timestamps are milliseconds, not seconds.

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

No. Version 1 keeps everything in memory; persistence to IndexedDB is on the roadmap. Server rendering
can [seed](/guides/ssr) a new page's cache.

## Does it work in Node?

Yes, with `mode: 'in-process'` or `Engine` from `@anishbenji/tscache/engine`. There is no `worker_threads` hosting.

## Can two origins share a cache?

No: workers are same-origin, and a `SharedWorker` is shared only among same-origin tabs.
