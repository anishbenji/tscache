import { describe, expect, it, vi } from "vitest";
import { CacheState } from "../src/engine/cache";
import { resolveCacheConfig } from "../src/engine/validate";
import type { HydrateResult, Range } from "../src/types";
import { batch, cache, observe, result } from "./cache-test-helpers";
import { payloadField, snapshotFixture } from "./snapshot-test-helpers";

describe("CacheState.hydrate — architecture §2.8, §4.5, N35", () => {
  it("H01 version mismatch skips all data, coverage and watermark changes without clearing", () => {
    const onVersionClear = vi.fn();
    const c = new CacheState(
      resolveCacheConfig({
        id: "version",
        interval: 10,
        alignmentOffset: 3,
        fields: { price: "f64", volume: "i16" },
        version: "live",
        finalizedUntil: 23,
      }),
      { onVersionClear },
    );
    c.put(batch([-7, 3, 23]));
    const before = observe(c);
    const outcome: HydrateResult = c.hydrate(snapshotFixture());
    expect(outcome).toEqual({ applied: [], skipped: "version-mismatch" });
    expect(observe(c)).toEqual(before);
    expect(onVersionClear).not.toHaveBeenCalled();
  });

  it.each([undefined, "seed"])(
    "H02 adopts or retains version %s without clearing existing data",
    (version) => {
      const c = cache(version === undefined ? {} : { version });
      c.put(batch([-7, 3], [700, 300]));
      expect(c.hydrate(snapshotFixture())).toEqual({
        applied: [{ start: 13, end: 43 }],
      });
      expect(c.version).toBe("seed");
      expect(c.finalizedUntil).toBe(63);
      expect(c.get({ start: -7, end: 43 })).toEqual(
        result(
          [-7, 3, 23, 43],
          [{ start: -7, end: 43 }],
          [],
          [700, 300, Number.NaN, 30],
          [-7, 3, 2, 3],
        ),
      );
    },
  );

  it("H03 an unversioned snapshot leaves the receiving version alone", () => {
    const c = cache({ version: "live" });
    const s = snapshotFixture();
    delete s.version;
    expect(c.hydrate(s)).toEqual({ applied: [{ start: 3, end: 43 }] });
    expect(c.version).toBe("live");
  });

  it.each([23, 33, 33.25, 63])(
    "H04 watermark %s advances only forwards before clipping applied parts",
    (finalizedUntil) => {
      const c = cache({ finalizedUntil: 33.25 });
      c.put(batch([3, 33, 43, 53], [300, 330, 430, 530]));
      c.invalidate({ start: 3, end: 33 });
      const source = cache({ finalizedUntil });
      source.put(batch([3, 23, 43], [10, Number.NaN, 30], [1, 2, 3]));
      const end =
        finalizedUntil === 23
          ? 13
          : finalizedUntil === 33
            ? 23
            : finalizedUntil === 33.25
              ? 33
              : 43;
      const applied = [{ start: 3, end }];
      expect(c.hydrate(source.snapshot({ start: 3, end: 53 }))).toEqual({
        applied,
      });
      expect(c.finalizedUntil).toBe(Math.max(33.25, finalizedUntil));
      const times =
        end < 23
          ? [3, 33, 43, 53]
          : end < 33
            ? [3, 23, 33, 43, 53]
            : [3, 23, 43, 53];
      const prices = times.map((t) =>
        t === 3
          ? 10
          : t === 23
            ? Number.NaN
            : t === 43 && end === 43
              ? 30
              : t * 10,
      );
      const volumes = times.map((t) =>
        t === 3 ? 1 : t === 23 ? 2 : t === 43 && end === 43 ? 3 : t,
      );
      expect(c.get({ start: 3, end: 53 })).toEqual(
        result(times, applied, [{ start: end + 10, end: 53 }], prices, volumes),
      );
    },
  );

  it("H05 fills only unknown final slots, replaces stale rows with gaps, and drops the snapshot tail", () => {
    const source = cache({ finalizedUntil: 63 });
    source.put(batch([3, 23, 43, 63, 73], [10, 20, 30, 40, 50]));
    source.invalidate({ start: 23, end: 23 });
    const c = cache({ finalizedUntil: 43 });
    c.put(
      batch(
        [-7, 3, 13, 23, 33, 43, 53, 63, 73],
        [-7, 300, 130, 230, 330, 430, 530, 630, 730],
      ),
    );
    c.invalidate({ start: 3, end: 3 });
    c.invalidate({ start: 23, end: 33 });
    expect(c.hydrate(source.snapshot({ start: 3, end: 73 }))).toEqual({
      applied: [
        { start: 3, end: 3 },
        { start: 33, end: 53 },
      ],
    });
    // Covered 13 survives; invalidated 23 is outside source coverage and survives;
    // stale 33/53 are removed as confirmed gaps; the source's 63/73 are dropped.
    expect(c.get({ start: -7, end: 73 })).toEqual(
      result(
        [-7, 3, 13, 23, 43, 63, 73],
        [
          { start: -7, end: 13 },
          { start: 33, end: 53 },
        ],
        [
          { start: 23, end: 23 },
          { start: 63, end: 73 },
        ],
        [-7, 10, 130, 230, 30, 630, 730],
      ),
    );
  });

  it("H06 an empty-coverage snapshot adopts metadata but writes none of its points", () => {
    const c = cache();
    c.put(batch([-7]));
    const s = { ...snapshotFixture(), coverage: [] };
    expect(c.hydrate(s)).toEqual({ applied: [] });
    expect(c.version).toBe("seed");
    expect(c.finalizedUntil).toBe(63);
    expect([...c.get({ start: -7, end: 73 }).timestamps]).toEqual([-7]);
  });

  it("H07 a confirmed-gap snapshot removes unknown points without needing a segment", () => {
    const c = cache();
    c.put(batch([3, 13, 23]));
    c.invalidate({ start: 13, end: 13 });
    const s = {
      ...snapshotFixture(),
      range: { start: 13, end: 13 },
      coverage: [{ start: 13, end: 13 }],
      segments: [],
    };
    expect(c.hydrate(s)).toEqual({ applied: [{ start: 13, end: 13 }] });
    expect(c.get({ start: 3, end: 23 })).toEqual(
      result([3, 23], [{ start: 3, end: 23 }], []),
    );
  });

  it("H08 accepts coverage separated by one slot and adjacent segment extents", () => {
    const source = cache({ segmentSlotCap: 2 });
    source.put(batch([3, 13, 23, 33]));
    const s = source.snapshot({ start: 3, end: 33 });
    expect(s.segments.map(({ start, count }) => ({ start, count }))).toEqual([
      { start: 3, count: 2 },
      { start: 23, count: 2 },
    ]);
    s.coverage = [
      { start: 3, end: 3 },
      { start: 23, end: 33 },
    ];
    const c = cache({ segmentSlotCap: 2 });
    expect(c.hydrate(s)).toEqual({ applied: s.coverage });
    expect(c.get(s.range)).toEqual(
      result([3, 23, 33], s.coverage, [{ start: 13, end: 13 }]),
    );
  });

  it("H09 accepts schema and payload fields in any order and ignores values beneath absent bits", () => {
    const c = cache();
    const s = snapshotFixture();
    s.fields = { volume: "i16", price: "f64" };
    const p = s.segments[0];
    if (!p) throw new Error("Missing fixture payload");
    p.fields.reverse();
    new Float64Array(payloadField(p, "price").data)[1] = 999;
    new Int16Array(payloadField(p, "volume").data)[3] = 99;
    expect(c.hydrate(s)).toEqual({ applied: [{ start: 3, end: 43 }] });
    expect(c.get(s.range)).toEqual(
      result(
        [3, 23, 43],
        [{ start: 3, end: 43 }],
        [
          { start: -7, end: -7 },
          { start: 53, end: 73 },
        ],
        [10, Number.NaN, 30],
        [1, 2, 3],
      ),
    );
    expect(
      c.snapshot(s.range).segments[0]?.fields.map(({ name }) => name),
    ).toEqual(["price", "volume"]);
  });

  it("H10 leaves the snapshot usable for another cache and never retains its buffers", () => {
    const s = snapshotFixture();
    const before = structuredClone(s);
    const a = cache();
    const b = cache();
    a.hydrate(s);
    expect(s).toEqual(before);
    expect(b.hydrate(s)).toEqual({ applied: [{ start: 3, end: 43 }] });
    const expected = a.get(s.range);
    for (const p of s.segments) {
      p.mask.fill(0);
      for (const { data } of p.fields) new Uint8Array(data).fill(0);
    }
    s.coverage.length = 0;
    expect(a.get(before.range)).toEqual(expected);
    expect(b.get(before.range)).toEqual(expected);
    a.put(batch([3], [999]));
    expect(b.get(before.range)).toEqual(expected);
  });

  it("H11 drops overlap warnings when replacing invalidated values", () => {
    const c = cache({ warnOnOverlapDiff: true });
    c.put(batch([3, 13, 23, 43], [900, 900, 900, 900]));
    c.invalidate({ start: 3, end: 43 });
    expect(c.hydrate(snapshotFixture())).toEqual({
      applied: [{ start: 3, end: 43 }],
    });
    expect([...c.get({ start: 3, end: 43 }).timestamps]).toEqual([3, 23, 43]);
  });
});

/** Independent set model: work one timestamp at a time, with no engine helpers. */
function runs(times: number[]): Range[] {
  const ranges: Range[] = [];
  for (const t of times) {
    const last = ranges.at(-1);
    if (last && last.end + 10 === t) last.end = t;
    else ranges.push({ start: t, end: t });
  }
  return ranges;
}

const cases = Array.from({ length: 32 }, (_, state) => ({ state }));
describe("snapshot algebra — architecture §4.5 properties (a)–(d)", () => {
  it.each(cases)(
    "P01 round trip, idempotence and never-overwrite for state $state",
    ({ state }) => {
      const times = [-17, -7, 3, 13, 23, 33, 43, 53, 63];
      const structural = { gapSplitK: 1 + (state % 3), segmentSlotCap: 4 };
      const watermark =
        state % 4 === 0
          ? undefined
          : state % 4 === 1
            ? 23.25
            : state % 4 === 2
              ? -6.5
              : 63;
      const version = state % 2 === 0 ? undefined : `v${state}`;
      const source = cache({
        ...structural,
        ...(version === undefined ? {} : { version }),
        ...(watermark === undefined ? {} : { finalizedUntil: watermark }),
      });
      const present = times.filter((_, i) => ((state >> (i % 5)) & 1) === 1);
      source.put(
        batch(
          present,
          present.map((t) => (t === 3 ? Number.NaN : t * 2)),
        ),
        { range: { start: -17, end: 63 } },
      );
      const forgotten = times.filter((_, i) => (state + i) % 3 === 0);
      for (const t of forgotten) source.invalidate({ start: t, end: t });
      const request = { start: -7.25, end: 53.25 };
      const read = source.get(request);
      const snapshot = source.snapshot(request);
      const covered = times.filter((t) =>
        read.coverage.some((r) => r.start <= t && t <= r.end),
      );
      const finalPoints = present.filter((t) => covered.includes(t));
      const empty = cache(structural);
      expect(empty.hydrate(snapshot)).toEqual({ applied: read.coverage });
      expect(empty.get(request)).toEqual(
        result(
          finalPoints,
          read.coverage,
          runs(times.filter((t) => !covered.includes(t))),
          finalPoints.map((t) => (t === 3 ? Number.NaN : t * 2)),
        ),
      );
      expect(empty.version).toBe(version);
      expect(empty.finalizedUntil).toBe(watermark);
      const after = observe(empty);
      expect(empty.hydrate(snapshot)).toEqual({ applied: [] });
      expect(observe(empty)).toEqual(after);
      expect(source.get(request, { snapshot: true }).snapshot).toEqual(
        snapshot,
      );

      const receiverWatermark = state % 2 === 0 ? 33.25 : 13;
      const c = cache({ ...structural, finalizedUntil: receiverWatermark });
      const existing = times.filter((_, i) => i % 2 === state % 2);
      for (const t of existing) c.put(batch([t], [1000 + t], [100 + t]));
      const known = new Set(existing.filter((t) => t < receiverWatermark));
      const effectiveWatermark =
        watermark === undefined
          ? receiverWatermark
          : Math.max(receiverWatermark, watermark);
      const parts = covered.filter(
        (t) => !known.has(t) && t < effectiveWatermark,
      );
      expect(c.hydrate(snapshot)).toEqual({ applied: runs(parts) });
      expect(c.finalizedUntil).toBe(effectiveWatermark);
      expect(c.version).toBe(version);
      const expectedTimes = times.filter((t) =>
        parts.includes(t) ? finalPoints.includes(t) : existing.includes(t),
      );
      const expectedCoverage = times.filter(
        (t) => known.has(t) || parts.includes(t),
      );
      expect(c.get(request)).toEqual(
        result(
          expectedTimes,
          runs(expectedCoverage),
          runs(times.filter((t) => !expectedCoverage.includes(t))),
          expectedTimes.map((t) =>
            parts.includes(t) ? (t === 3 ? Number.NaN : t * 2) : 1000 + t,
          ),
          expectedTimes.map((t) => (parts.includes(t) ? t : 100 + t)),
        ),
      );
    },
  );
});
