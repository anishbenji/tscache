# Segments and slots

## Fields and dtypes

A cache declares its fields at creation, each with a dtype:

| Dtype | Typed array | Bytes |
|---|---|---|
| `f64` | `Float64Array` | 8 |
| `f32` | `Float32Array` | 4 |
| `i32`, `u32` | `Int32Array`, `Uint32Array` | 4 |
| `i16`, `u16` | `Int16Array`, `Uint16Array` | 2 |
| `i8`, `u8` | `Int8Array`, `Uint8Array` | 1 |

`f64` is the usual choice. 64-bit integers (BigInt) and `f16` are not supported. The runtime list is
exported as `DTYPES`.

**Presence is per point, not per field.** A point exists with a value in every field, or does not
exist. A float field can mark a missing value with `NaN`, which is legal and survives every transfer.
An integer field has no such value. If an integer field can be missing on its own, store it as `f32` or
`f64` with `NaN` for missing (exact for integers up to 2^24 and 2^53), or keep it in a cache of its
own. Different fetches cannot supply different fields of one point: model independent series as separate
caches and join them when you read.

## Dense segments

Points are stored in **dense segments**: a run of slots with one bit per slot for presence and one typed
array per field. A slot's timestamp is implicit (`start + i × interval`), so a cached bar costs its
fields' bytes and one bit; a one-minute OHLCV bar of five `f64` fields keeps 40 bytes plus the bit.

Two settings shape the layout:

- **`gapSplitK`** (default 4): a segment splits where **more than K** consecutive slots hold no point.
  With K = 4 at one minute, points at 10:00 and 10:05 (four empty slots between) share a segment; 10:00
  and 10:06 (five) do not. A short gap costs its slots' storage; a long one costs nothing.
- **`segmentSlotCap`** (default 32 768, at most 2^31 − 1): no segment spans more slots than this, and
  no segment crosses a multiple of it. The slots are divided into fixed pages, so the layout depends only
  on which points are present, never on the order they arrived in.

Both are part of a cache's structure: every tab must open the cache with the same values. They are
tuning knobs; the defaults suit one-minute bars with nights and weekends between sessions.

Coverage does not care about segments: a confirmed gap splits segments, never coverage.

## One format, three uses

A segment travels as a self-describing payload (`DenseSegmentPayload`):

```ts
interface DenseSegmentPayload {
  format: 1;
  layout: "dense";
  start: number; // the first slot's timestamp
  count: number; // slots; slot i is at start + i * interval
  interval: number;
  alignmentOffset: number;
  mask: Uint8Array; // ceil(count / 8) bytes, slot i is bit (i & 7) of byte (i >> 3)
  fields: { name: string; dtype: Dtype; data: ArrayBuffer }[]; // little-endian
}
```

The same structure is meant for three uses: the message between worker and page, the record of a
future IndexedDB persistence layer, and the server-rendering payload in a page. Today you meet it inside
a [snapshot](/usage/snapshots). Field data is little-endian, the native order of every supported
platform.

The rejected alternatives and the exact layout rules are in §4.2–§4.3 of the
[architecture document](https://github.com/anishbenji/tscache/blob/main/docs/architecture.md).
