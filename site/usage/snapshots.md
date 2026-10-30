# Snapshots

A **snapshot** is what a cache knows about a range: the present points inside it, the covered
sub-ranges, the dataset version and the watermark in force, and the grid and schema they belong to. A
server takes one with its read and puts it in the page; the browser applies it to its own cache, so its
first read fetches only what the server did not know.

## Taking one

`get(range, { snapshot: true })` resolves with the result and its `snapshot`, both from the same read:
`snapshot.coverage` equals the result's `coverage`, and its points are the result's points. Equal
cache state gives equal snapshots. The snapshot's buffers are fresh and are moved to the page with the
result. `snapshot.range` is the request snapped outward.

## Carrying one in HTML: encodeSnapshot and decodeSnapshot

A snapshot holds binary buffers. `encodeSnapshot(snapshot)` returns it with each mask and field buffer
as base64 text: a plain JSON value. `decodeSnapshot(encoded)` restores it. `NaN`, which `JSON` would
turn into `null`, survives. Both use `btoa`/`atob`, so they run in browsers and Node alike.

<<< @/snippets/snapshots.ts#server{ts}

Escaping for a `<script>` element is yours: replace every `<` in the JSON, as above. `decodeSnapshot`
checks the shape only and throws `TscacheError` for anything that is not an encoded snapshot; whether the
snapshot fits the cache is `hydrate`'s to check.

## Applying one: hydrate

<<< @/snippets/snapshots.ts#browser{ts}

`cache.hydrate(snapshot)` runs as one call inside the worker, so no other tab's write lands in the
middle. Its rules:

- **Checked first, in full.** The snapshot must describe this cache: the same interval, offset and
  fields, and well-formed ranges and payloads. Anything else throws `TscacheError` before anything
  changes; a snapshot is made by the library, so a malformed one is corruption, never repaired.
- **Version.** If both the snapshot and the cache have a version and they differ, nothing is applied and
  the result is `{ applied: [], skipped: 'version-mismatch' }`. A cache without a version adopts the
  snapshot's without clearing.
- **Watermark.** The snapshot's `finalizedUntil` advances the cache's watermark, never moves it back.
- **Only where nothing is known.** Each covered range of the snapshot, minus what the cache already
  covers and minus its provisional region, is written as authoritative. Covered slots are never touched,
  so a newer fetch by another tab survives; the snapshot's own provisional tail is not applied, and the
  browser fetches it.
- **No events.** `hydrate` never clears, so it emits no `cacheCleared` and no `mergeWarning`.

It resolves with `applied`, the ranges it wrote, ascending. The snapshot is cloned to the worker, not
transferred, so it stays usable: the client that replaces a lost one can be seeded from the same object.

::: tip Hydration is an optimisation
A worker from before `hydrate` (a stale cached script) rejects the call with `TscacheError`
"unknown op hydrate", and a `get` with `snapshot: true` returns no `snapshot`. Treat that as nothing
applied: the cache fetches instead.
:::

With an `Engine`, `engine.snapshot(cacheId, range)` takes a snapshot without a read, for persistence
and tests ([The engine](/usage/engine)). [Server rendering](/guides/ssr) puts it all together. The
design is §2.8 of the [architecture document](https://github.com/anishbenji/tscache/blob/main/docs/architecture.md).
