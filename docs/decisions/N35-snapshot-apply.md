# N35: How a snapshot is applied

Row N35 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**One `hydrate` engine call.** If the snapshot and the cache both have a version and they differ, nothing is applied and the result says so; a seed never clears and adopts as a versioned `put` does (§4.5), since a stale page would wipe a newer cache. An unversioned cache adopts the snapshot's version without clearing (as N18). Each covered range of the snapshot, minus the cache's coverage and minus its volatile region (after the watermark advance; step ⑮ T3), is put with that part as its range, so covered slots, and with them another tab's fetch, are never overwritten; one engine call cannot interleave with another tab's write, which closes the seed race (step ⑭ R2-2). The watermark travels as `meta.finalizedUntil` (forwards only, N17; clipped by §4.5 and N19). The snapshot's provisional tail (points outside its coverage) is dropped, and the browser fetches it. The result is `{ applied: Range[]; skipped?: 'version-mismatch' }`. An unknown `format`, or a grid or schema that differs from the cache, throws `TscacheError` before anything changes; an unknown cache throws `UnknownCacheError`. Rejected for the tail: filling absent slots only (needs a fill-absent primitive the engine lacks); a plain upsert (can replace a newer provisional point with an older one until the next `get`). User-confirmed 2026-10-23

## Amendment, 2026-11-16

User decision 65, row D7 option (a) (N77, step 114): `hydrate` now sends `cacheChanged` for the parts it applied and for the coverage its first watermark withdrew. The "No events" bullet of architecture §2.8 is amended for that event only; `hydrate` still never clears, so it emits no `cacheCleared`, and it reports no `mergeWarning`.

## Amendment, 2026-11-21

User decision 83, rows G9 option (a) and G8 option (c) (N114, N113, step 129): `hydrate`'s validation gains three things, for a calendar cache only. Rule 1 accepts `format: 2` with a `grid` equal to the cache's, where a fixed cache requires `format: 1` and its `interval` and `alignmentOffset`. A rule after it compares the snapshot's charge with the lookup budget, before any instant is converted. A rule after rule 5 requires each stored slot index to be the slot its instant has under the reader's zone data. A failure of any of them throws `TscacheError` before anything changes, as every other malformation does (architecture §4.5).
