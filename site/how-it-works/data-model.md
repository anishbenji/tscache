<script setup>
import "./diagrams.css";
</script>

# Data model

One cache is one `CacheState` inside the engine. It holds four things: the points, stored in dense
segments on the cache's grid; the coverage index, which records which slots are known; the dataset
version; and the finalized watermark. The diagram shows one small cache; the explanations below follow it
from top to bottom.

<figure class="hiw-figure">
<!--@include: ./data-model.svg-->
</figure>

The example uses `gapSplitK` 4 and, so that a page edge fits in the picture, a `segmentSlotCap` of 16
(the default is 32 768). Its watermark puts the first provisional slot at 20.

## Grid and slots

A cache's `interval` and `alignmentOffset` define its grid: the timestamps
`t = alignmentOffset + slot × interval` for integer slots. Every point a cache stores lies on a grid
point, and a cache stores at most one point per slot. All range arithmetic runs on slot indices; one
module, `grid.ts`, converts between milliseconds and slots.

- A read or an invalidation snaps its range outward: the start down to the slot at or before it, the end
  up to the slot at or after it.
- A put's authority range snaps inward, to the grid points inside it, so a put never claims a slot its
  caller did not name.
- A put's timestamps must lie on the grid exactly.

Drawn from:

- [`packages/tscache/src/grid.ts#Grid`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/grid.ts)
- [`packages/tscache/src/grid.ts#msOf`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/grid.ts)
- [`packages/tscache/src/grid.ts#slotOf`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/grid.ts)
- [`packages/tscache/src/grid.ts#snapOut`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/grid.ts)
- [`packages/tscache/src/grid.ts#snapIn`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/grid.ts)

## Segments

The points live in `DenseSegment`s. A segment covers a run of consecutive slots with one typed array per
field, of the field's dtype, and a presence mask of one bit per slot. A slot's timestamp is not stored:
it follows from the slot's position.

The cache's `SegmentStore` decides where one segment ends and the next begins. Two present points with no
present point between them share a segment exactly when

- at most `gapSplitK` slots between them hold no point (default 4), and
- they lie on the same page: pages are `segmentSlotCap` slots long and start at multiples of it (default
  32 768).

In the diagram, segment A keeps the one empty slot 4; the six empty slots 8 to 13 split A from B; the page
edge at slot 16 splits B from C, although slots 15 and 16 both hold points. The layout therefore depends
only on which points are present, never on the order in which they arrived.

Drawn from:

- [`packages/tscache/src/segment/dense.ts#DenseSegment`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/segment/dense.ts)
- [`packages/tscache/src/segment/types.ts#Segment`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/segment/types.ts)
- [`packages/tscache/src/segment/dtype.ts#FIELD_ARRAYS`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/segment/dtype.ts)
- [`packages/tscache/src/engine/merge.ts#SegmentStore`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/engine/merge.ts)
- [`packages/tscache/src/engine/merge.ts#pageOf`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/engine/merge.ts)
- [`packages/tscache/src/engine/validate.ts#DEFAULT_GAP_SPLIT_K`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/engine/validate.ts)
- [`packages/tscache/src/engine/validate.ts#DEFAULT_SEGMENT_SLOT_CAP`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/engine/validate.ts)

## Coverage

Coverage is kept apart from the points. The `CoverageIndex` is a sorted list of disjoint, non-adjacent
slot ranges, each meaning "the backend was asked about these slots, and the answer is final". A put
records the slots it is authoritative for (its `range`, or without one the span of its points), minus
the provisional slots; overlapping and adjacent ranges merge, and an invalidation
subtracts a range, which may split one in two. Coverage ignores segments and pages: in the diagram, the
range 14 to 19 runs across the page edge and across both segment B and segment C.

Together, coverage and points give each slot one of four states:

| Slot state            | What a read does                                  | In the diagram      |
| --------------------- | ------------------------------------------------- | ------------------- |
| covered, with a point | returns the point; the slot is not fetched again  | 0–3, 5–7, 14–17, 19 |
| covered, no point     | returns nothing: a **confirmed real gap**         | 4, 8–11, 18         |
| not covered, no point | reports it in a miss; a fetching read asks for it | 12–13, 22–23        |
| not covered, a point  | returns the point, and a fetching read asks again | 20–21               |

A read returns every present point in its range, covered or not, with the covered sub-ranges and the
uncovered ones as misses of reason `'uncached'`; the two tile the range exactly. When the orchestrator
served the read and a fetch failed, it relabels the part of a miss that fetch was asked for as
`'fetch-failed'` or `'auth-pending'`.

The last state arises in two ways: an invalidation forgets coverage but keeps the points, and points at
or after the watermark are never covered.

Drawn from:

- [`packages/tscache/src/coverage.ts#CoverageIndex`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/coverage.ts)
- [`packages/tscache/src/engine/read.ts#read`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/engine/read.ts)
- [`packages/tscache/src/engine/cache.ts#CacheState`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/engine/cache.ts)
- [`packages/tscache/src/orchestrator/orchestrator.ts#annotate`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/orchestrator/orchestrator.ts)
- [`packages/tscache/src/types.ts#MissReason`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/types.ts)

## The watermark

`finalizedUntil` is the cache's finalized watermark, in milliseconds. Its slot is the first grid point at
or after it; from that slot on, points are **provisional**. They are stored and returned, but their slots
are never recorded as coverage, so every fetching read that includes them asks the backend again, and the
answer's values overwrite them.

- It starts at `CacheConfig.finalizedUntil`, when the config sets one.
- A put's or a response's `meta.finalizedUntil` only moves it forwards. Such a put is also authoritative
  only below its own watermark: past it, its points are merged but replace nothing and record no
  coverage.
- `setFinalizedUntil(t)` sets it exactly. Moving it back withdraws coverage from its new slot on.

Drawn from:

- [`packages/tscache/src/engine/cache.ts#CacheState`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/engine/cache.ts)
- [`packages/tscache/src/grid.ts#slotAtOrAfter`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/grid.ts)
- [`packages/tscache/src/types.ts#CacheConfig`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/types.ts)
- [`packages/tscache/src/types.ts#PutBatch`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/types.ts)

## The dataset version

A cache can carry a dataset version, a non-empty string. It comes from `CacheConfig.version`, or else from
the first `meta.version` a put or a response reports. A put or a response with a different version
clears the cache's points and coverage, adopts the new version and is then applied; the engine reports
the clear as `cacheCleared` with reason `'version-mismatch'`. A put without `meta.version` leaves the
version as it is.

Drawn from:

- [`packages/tscache/src/engine/cache.ts#CacheState`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/engine/cache.ts)
- [`packages/tscache/src/engine/engine.ts#EngineEvents`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/engine/engine.ts)

## The same data, outside the engine

A segment leaves the engine as a `DenseSegmentPayload`: its first timestamp, its slot count, the grid,
the mask and one little-endian buffer per field. A `Snapshot` wraps the payloads of a range with that
range's coverage, version and watermark. The same snapshot is what `get(range, { snapshot: true })`
returns for server rendering and what the persister stores, one per page, in IndexedDB.

Drawn from:

- [`packages/tscache/src/types.ts#DenseSegmentPayload`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/types.ts)
- [`packages/tscache/src/types.ts#Snapshot`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/types.ts)
- [`packages/tscache/src/engine/snapshot.ts#takeSnapshot`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/engine/snapshot.ts)
- [`packages/tscache/src/persist/records.ts#PageRecord`](https://github.com/anishbenji/tscache/blob/main/packages/tscache/src/persist/records.ts)
