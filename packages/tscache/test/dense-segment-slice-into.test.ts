import { describe, expect, it } from "vitest";
import type { Grid, SlotRange } from "../src/grid";
import { DenseSegment } from "../src/segment/dense";
import type { Columns, Segment } from "../src/segment/types";
import type { Dtype } from "../src/types";

// Architecture §4.2: `countIn` and `sliceInto`, the read path's
// single-copy pair. Every case is checked against `slice`, whose contract
// the pair shares, and against a set of present slots.
const grid: Grid = { interval: 10, alignmentOffset: 3 };
const fields: Readonly<Record<string, Dtype>> = { price: "f64", volume: "i16" };
const options = { grid, fields, slotCap: 32_768 };

/** Untouched elements of a target hold this, so a stray write shows. */
const SENTINEL = -7;

function span(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

function points(slots: number[]): Columns {
  return {
    slots: new Float64Array(slots),
    fields: {
      price: new Float64Array(slots.map((slot) => slot * 1.5)),
      volume: new Int16Array(slots),
    },
  };
}

/** A target of `length` elements per array, every element SENTINEL. */
function target(length: number): Columns {
  return {
    slots: new Float64Array(length).fill(SENTINEL),
    fields: {
      price: new Float64Array(length).fill(SENTINEL),
      volume: new Int16Array(length).fill(SENTINEL),
    },
  };
}

/** `selected` written at `at` into a target of `length`; SENTINEL elsewhere. */
function expected(selected: number[], at: number, length: number): Columns {
  const out = target(length);
  out.slots.set(selected, at);
  out.fields.price?.set(
    selected.map((slot) => slot * 1.5),
    at,
  );
  out.fields.volume?.set(selected, at);
  return out;
}

/**
 * Reads `range` with countIn and sliceInto at offset `at`, with `pad` spare
 * elements after the points, and checks both against `selected` and slice.
 */
function expectRead(
  segment: Segment,
  range: SlotRange,
  selected: number[],
  at = 3,
  pad = 2,
): void {
  const count = segment.countIn(range);
  expect(count).toBe(selected.length);
  const length = at + count + pad;
  const out = target(length);
  expect(segment.sliceInto(range, out, at)).toBe(count);
  expect(out).toEqual(expected(selected, at, length));
  const slice = segment.slice(range);
  expect(out.slots.subarray(at, at + count)).toEqual(slice.slots);
  expect(out.fields.price?.subarray(at, at + count)).toEqual(
    slice.fields.price,
  );
  expect(out.fields.volume?.subarray(at, at + count)).toEqual(
    slice.fields.volume,
  );
}

/**
 * Slots 0..19, built by a prepend after an append so the buffers start
 * before the extent; then, if `gappy`, slots 4..6 and 12 cleared.
 */
function segmentOf(gappy: boolean): Segment {
  const segment = new DenseSegment(options);
  segment.mergeFrom(points(span(10, 19)));
  segment.mergeFrom(points(span(0, 9)));
  if (gappy) {
    segment.mergeFrom(points([]), { start: 4, end: 6 });
    segment.mergeFrom(points([]), { start: 12, end: 12 });
  }
  return segment;
}

const whole = span(0, 19);
const runs = [...span(0, 3), ...span(7, 11), ...span(13, 19)];

const ranges: { name: string; range: SlotRange }[] = [
  { name: "entire extent", range: { start: 0, end: 19 } },
  { name: "both flanks beyond", range: { start: -5, end: 25 } },
  { name: "left clipped", range: { start: -50, end: 3 } },
  { name: "right clipped", range: { start: 17, end: 50 } },
  { name: "first slot only", range: { start: 0, end: 0 } },
  { name: "last slot only", range: { start: 19, end: 19 } },
  { name: "ends one before the extent", range: { start: -9, end: -1 } },
  { name: "starts one after the extent", range: { start: 20, end: 29 } },
  { name: "touches the extent's first slot", range: { start: -9, end: 0 } },
  { name: "touches the extent's last slot", range: { start: 19, end: 29 } },
  { name: "interior across both gaps", range: { start: 2, end: 14 } },
  { name: "starts and ends inside gaps", range: { start: 5, end: 12 } },
  { name: "exactly one gap", range: { start: 4, end: 6 } },
  { name: "single absent slot", range: { start: 12, end: 12 } },
  { name: "present run between gaps", range: { start: 7, end: 11 } },
  { name: "run touching gaps on both sides", range: { start: 6, end: 13 } },
];

describe("DenseSegment countIn and sliceInto — architecture §4.2", () => {
  it.each(ranges)("a fully present segment: $name", ({ range }) => {
    const selected = whole.filter(
      (slot) => range.start <= slot && slot <= range.end,
    );
    expectRead(segmentOf(false), range, selected);
  });

  it.each(ranges)("a segment with gaps: $name", ({ range }) => {
    const selected = runs.filter(
      (slot) => range.start <= slot && slot <= range.end,
    );
    expectRead(segmentOf(true), range, selected);
  });

  it("an empty segment counts and writes nothing", () => {
    const segment = new DenseSegment(options);
    expectRead(segment, { start: -10, end: 10 }, []);
    // A segment emptied by a replace reads the same.
    const emptied = segmentOf(true);
    emptied.mergeFrom(points([]), { start: -100, end: 100 });
    expectRead(emptied, { start: -10, end: 30 }, []);
  });

  it("writes at offset zero and into a target with no spare element", () => {
    expectRead(segmentOf(true), { start: 0, end: 19 }, runs, 0, 0);
    expectRead(segmentOf(false), { start: 0, end: 19 }, whole, 0, 0);
  });

  it("a segment made whole again reads as fully present", () => {
    const segment = segmentOf(true);
    segment.mergeFrom(points([4, 5, 6, 12]));
    expectRead(segment, { start: -1, end: 20 }, whole);
  });

  it.each([1, 8, 32_768])(
    "reads a segment spanning exactly its slot cap of %i",
    (slotCap) => {
      const segment = new DenseSegment({ ...options, slotCap });
      const start = -7;
      const end = start + slotCap - 1;
      const all = span(start, end);
      segment.mergeFrom(points(all));
      expectRead(segment, { start: start - 1, end: end + 1 }, all);
      if (slotCap === 1) return;
      // The same span with every other slot cleared, read whole and from
      // its second slot (absent) to its last but one (present only when
      // the cap is even).
      const kept = all.filter((_, i) => i % 2 === 0);
      segment.mergeFrom(points(kept), { start, end });
      expectRead(segment, { start, end }, kept);
      expectRead(
        segment,
        { start: start + 1, end: end - 1 },
        kept.filter((slot) => start + 1 <= slot && slot <= end - 1),
      );
    },
  );

  it("converts into the target's arrays without sharing a buffer", () => {
    const segment = segmentOf(false);
    const out = target(25);
    segment.sliceInto({ start: 0, end: 19 }, out, 5);
    out.slots.fill(0);
    out.fields.price?.fill(0);
    out.fields.volume?.fill(0);
    expect(segment.slice({ start: 0, end: 19 })).toEqual(points(whole));
    expect(segment.lookup(7)).toEqual({ price: 10.5, volume: 7 });
  });

  it("rejects a target too short for the points, writing nothing", () => {
    for (const segment of [segmentOf(false), segmentOf(true)]) {
      const count = segment.countIn({ start: 0, end: 19 });
      for (const [length, at] of [
        [count - 1, 0],
        [count, 1],
        [count + 3, 4],
      ] as const) {
        const out = target(length);
        expect(() => segment.sliceInto({ start: 0, end: 19 }, out, at)).toThrow(
          RangeError,
        );
        expect(out).toEqual(target(length));
      }
    }
  });

  it.each([
    { name: "negative", at: -1 },
    { name: "fractional", at: 0.5 },
    { name: "NaN", at: Number.NaN },
  ])("rejects a $name offset, writing nothing", ({ at }) => {
    const segment = segmentOf(true);
    const out = target(40);
    expect(() => segment.sliceInto({ start: 0, end: 19 }, out, at)).toThrow(
      RangeError,
    );
    expect(out).toEqual(target(40));
  });

  it.each([
    { name: "fractional start", range: { start: 0.5, end: 2 } },
    { name: "NaN end", range: { start: 0, end: Number.NaN } },
    {
      name: "start beyond safe integers",
      range: { start: -(2 ** 53), end: 0 },
    },
    { name: "inverted endpoints", range: { start: 2, end: -2 } },
  ])("rejects a malformed range ($name), even when empty", ({ range }) => {
    for (const segment of [new DenseSegment(options), segmentOf(true)]) {
      expect(() => segment.countIn(range)).toThrow(RangeError);
      const out = target(40);
      expect(() => segment.sliceInto(range, out, 0)).toThrow(RangeError);
      expect(out).toEqual(target(40));
    }
  });

  it.each([7, 0xbadcafe])(
    "random runs, ranges and offsets match a set of present slots (seed %i)",
    (seed) => {
      let state = seed >>> 0;
      const next = (min: number, max: number): number => {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        return min + (state % (max - min + 1));
      };
      const segment = new DenseSegment(options);
      const present = new Set<number>();
      for (let step = 0; step < 60; step += 1) {
        const start = next(-40, 40);
        const end = start + next(0, 12);
        if (next(0, 3) === 0) {
          segment.mergeFrom(points([]), { start, end });
          for (const slot of span(start, end)) present.delete(slot);
        } else {
          segment.mergeFrom(points(span(start, end)));
          for (const slot of span(start, end)) present.add(slot);
        }
        const a = next(-50, 60);
        const b = next(-50, 60);
        const range = { start: Math.min(a, b), end: Math.max(a, b) };
        const selected = [...present]
          .filter((slot) => range.start <= slot && slot <= range.end)
          .sort((x, y) => x - y);
        expectRead(segment, range, selected, next(0, 5), next(0, 3));
      }
    },
  );
});
