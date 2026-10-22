import { describe, expect, it } from "vitest";
import { InvalidRangeError } from "../src/errors";
import type { DenseSegmentPayload, Range } from "../src/types";
import { batch, cache, malformedRanges, result } from "./cache-test-helpers";
import { payloadField, snapshotPayload } from "./snapshot-test-helpers";

describe("CacheState.snapshot — architecture §2.8, §3.4, §4.2, §4.5", () => {
  it("S01 snaps outward, clips coverage and emits tight payloads with the specified mask and fields", () => {
    const c = cache();
    c.put(
      batch([-7, 3, 23, 43, 53], [7, 10, Number.NaN, 30, 53], [7, 1, 2, 3, 53]),
    );
    const request = { start: 3.25, end: 42.75 };
    expect(c.snapshot(request)).toEqual({
      format: 1,
      interval: 10,
      alignmentOffset: 3,
      fields: { price: "f64", volume: "i16" },
      range: { start: 3, end: 43 },
      coverage: [{ start: 3, end: 43 }],
      segments: [snapshotPayload()],
    });
    expect(c.snapshot(request).coverage).toEqual(c.get(request).coverage);
    expect(request).toEqual({ start: 3.25, end: 42.75 });
    // Explicit byte check pins little endian independently of native array views.
    expect(
      new Uint8Array(
        payloadField(
          c.snapshot(request).segments[0] as DenseSegmentPayload,
          "volume",
        ).data,
      ),
    ).toEqual(new Uint8Array([1, 0, 0, 0, 2, 0, 0, 0, 3, 0]));
  });

  it("S02 includes current metadata and present points outside coverage, omitting unset metadata", () => {
    const c = cache();
    const empty = c.snapshot({ start: -7, end: 73 });
    expect(empty).not.toHaveProperty("version");
    expect(empty).not.toHaveProperty("finalizedUntil");
    c.put({
      ...batch([3, 13, 23, 33]),
      meta: { version: "current", finalizedUntil: 23.25 },
    });
    c.invalidate({ start: 3, end: 3 });
    const s = c.snapshot({ start: 3, end: 33 });
    expect(s).toMatchObject({
      version: "current",
      finalizedUntil: 23.25,
      coverage: [{ start: 13, end: 23 }],
    });
    expect(s.segments).toHaveLength(1);
    expect(s.segments[0]).toMatchObject({
      start: 3,
      count: 4,
      mask: new Uint8Array([15]),
    });
    expect(
      new Float64Array(
        payloadField(s.segments[0] as DenseSegmentPayload, "price").data,
      ),
    ).toEqual(new Float64Array([3, 13, 23, 33]));
  });

  it("S03 emits one payload per intersecting store segment, respecting K splits and fixed pages", () => {
    const c = cache({ gapSplitK: 1, segmentSlotCap: 8 });
    c.put(batch([3, 13, 43, 73, 83, 93]));
    const s = c.snapshot({ start: 13, end: 83 });
    expect(
      s.segments.map(({ start, count, mask }) => ({
        start,
        count,
        mask: [...mask],
      })),
    ).toEqual([
      { start: 13, count: 1, mask: [1] },
      { start: 43, count: 1, mask: [1] },
      { start: 73, count: 1, mask: [1] },
      { start: 83, count: 1, mask: [1] },
    ]);
    // A request crossing only absent slots of a segment emits no payload.
    const sparse = cache();
    sparse.put(batch([3, 43]));
    expect(sparse.snapshot({ start: 13, end: 33 }).segments).toEqual([]);
  });

  it.each([
    {
      name: "single present slot",
      range: { start: 23, end: 23 },
      times: [23],
      coverage: [{ start: 23, end: 23 }],
      count: 1,
    },
    {
      name: "confirmed gap",
      range: { start: 13, end: 13 },
      times: [],
      coverage: [{ start: 13, end: 13 }],
      count: 0,
    },
    {
      name: "wider than data",
      range: { start: -17, end: 73 },
      times: [3, 23, 43],
      coverage: [{ start: 3, end: 43 }],
      count: 1,
    },
    {
      name: "empty uncovered range",
      range: { start: 63, end: 73 },
      times: [],
      coverage: [],
      count: 0,
    },
  ])("S04 fencepost: $name", ({ range, times, coverage, count }) => {
    const c = cache();
    c.put(batch([3, 23, 43]));
    const s = c.snapshot(range);
    expect(s.range).toEqual(range);
    expect(s.coverage).toEqual(coverage);
    expect(s.segments).toHaveLength(count);
    const e = cache();
    expect(e.hydrate(s)).toEqual({ applied: coverage });
    expect([...e.get(range).timestamps]).toEqual(times);
    if (times.length === 1)
      expect(s.segments[0]).toMatchObject({
        start: 23,
        count: 1,
        mask: new Uint8Array([1]),
      });
  });

  it("S05 payload spans exactly the default slot cap, with the last mask bit present", () => {
    const c = cache({ gapSplitK: 32_768 });
    const end = 3 + 10 * (32_768 - 1);
    c.put(batch([3, end], [1, 2], [1, 2]));
    const s = c.snapshot({ start: 3, end });
    expect(s.segments).toHaveLength(1);
    const p = s.segments[0] as DenseSegmentPayload;
    expect(p).toMatchObject({ start: 3, count: 32_768 });
    const mask = new Uint8Array(4096);
    mask[0] = 1;
    mask[4095] = 128;
    expect(p.mask).toEqual(mask);
    expect(payloadField(p, "price").data.byteLength).toBe(32_768 * 8);
    expect(payloadField(p, "volume").data.byteLength).toBe(32_768 * 2);
    const e = cache({ gapSplitK: 32_768 });
    expect(e.hydrate(s)).toEqual({ applied: [{ start: 3, end }] });
    expect(e.get({ start: 3, end })).toEqual(
      result([3, end], [{ start: 3, end }], [], [1, 2], [1, 2]),
    );
  });

  it("S06 owns fresh buffers, schema and range objects; transferring them cannot detach the cache", () => {
    const c = cache();
    c.put(batch([3, 23, 43], [10, Number.NaN, 30], [1, 2, 3]));
    const range = { start: -7, end: 73 };
    const first = c.snapshot(range);
    const saved = structuredClone(first);
    const second = c.snapshot(range);
    expect(first).toEqual(second);
    expect(first.range).not.toBe(second.range);
    expect(first.coverage[0]).not.toBe(second.coverage[0]);
    expect(first.fields).not.toBe(c.config.fields);
    first.range.start = -197;
    const covered = first.coverage[0] as Range;
    covered.end = -7;
    first.fields.price = "f32";
    for (const p of first.segments) {
      p.mask.fill(0);
      for (const { data } of p.fields) new Uint8Array(data).fill(0);
    }
    expect(second).toEqual(saved);
    expect(c.snapshot(range)).toEqual(saved);
    const buffers = second.segments.flatMap((p) => [
      p.mask.buffer,
      ...p.fields.map(({ data }) => data),
    ]);
    expect(new Set(buffers).size).toBe(buffers.length);
    expect(structuredClone(second, { transfer: buffers })).toEqual(saved);
    expect(c.snapshot(range)).toEqual(saved);
    c.put(batch([23], [999]));
    expect(saved.segments).toEqual([snapshotPayload()]);
  });

  it("S07 equal state reached in different arrival orders gives equal snapshots", () => {
    const a = cache({ gapSplitK: 1, segmentSlotCap: 8 });
    const b = cache({ gapSplitK: 1, segmentSlotCap: 8 });
    a.put(batch([-17, 3, 13, 43, 73, 83, 93]));
    for (const t of [93, 83, 73, 43, 13, 3, -17]) b.put(batch([t]));
    // Fill the gaps as empty authority without rewriting any present row.
    for (const range of [
      { start: -7, end: -7 },
      { start: 23, end: 33 },
      { start: 53, end: 63 },
    ])
      b.put(batch([]), { range });
    expect(a.snapshot({ start: -27, end: 103 })).toEqual(
      b.snapshot({ start: -27, end: 103 }),
    );
  });

  it("S08 get snapshot matches the same read's columns and coverage (property d), only when requested", () => {
    const c = cache({ finalizedUntil: 33 });
    c.put(batch([3, 13, 23, 33]));
    const range = { start: 3, end: 43 };
    const read = c.get(range, { snapshot: true });
    expect(read.snapshot).toEqual(c.snapshot(range));
    expect(read.snapshot?.coverage).toEqual(read.coverage);
    expect(read).toMatchObject(
      result(
        [3, 13, 23, 33],
        [{ start: 3, end: 23 }],
        [{ start: 33, end: 43 }],
      ),
    );
    expect(read.snapshot?.segments[0]).toMatchObject({
      start: 3,
      count: 4,
      mask: new Uint8Array([15]),
    });
    expect(
      new Float64Array(
        payloadField(read.snapshot?.segments[0] as DenseSegmentPayload, "price")
          .data,
      ),
    ).toEqual(read.fields.price);
    expect(
      new Int16Array(
        payloadField(
          read.snapshot?.segments[0] as DenseSegmentPayload,
          "volume",
        ).data,
      ),
    ).toEqual(read.fields.volume);
    expect(c.get(range)).not.toHaveProperty("snapshot");
    expect(c.get(range, { snapshot: false })).not.toHaveProperty("snapshot");
  });

  it("S10 clipping rebases a multi-byte mask and emits fields in declaration order", () => {
    const c = cache({ gapSplitK: 8, fields: { zeta: "i16", alpha: "f64" } });
    c.put({
      timestamps: [3, 33, 73, 83, 163],
      fields: { alpha: [1, 2, 3, 4, 5], zeta: [10, 20, 30, 40, 50] },
    });
    const s = c.snapshot({ start: 13, end: 173 });
    expect(s.segments).toHaveLength(1);
    const p = s.segments[0] as DenseSegmentPayload;
    expect(p).toMatchObject({
      start: 33,
      count: 14,
      mask: new Uint8Array([0x31, 0x20]),
    });
    expect(p.fields.map(({ name, dtype }) => ({ name, dtype }))).toEqual([
      { name: "zeta", dtype: "i16" },
      { name: "alpha", dtype: "f64" },
    ]);
    expect(new Int16Array(payloadField(p, "zeta").data)).toEqual(
      new Int16Array([20, 0, 0, 0, 30, 40, 0, 0, 0, 0, 0, 0, 0, 50]),
    );
    expect(new Float64Array(payloadField(p, "alpha").data)).toEqual(
      new Float64Array([2, 0, 0, 0, 3, 4, 0, 0, 0, 0, 0, 0, 0, 5]),
    );
  });

  it.each(malformedRanges)(
    "S09 snapshot and snapshot-enabled get reject malformed range %j",
    (range) => {
      const c = cache();
      expect(() => c.snapshot(range as Range)).toThrow(InvalidRangeError);
      expect(() => c.get(range as Range, { snapshot: true })).toThrow(
        InvalidRangeError,
      );
    },
  );
});
