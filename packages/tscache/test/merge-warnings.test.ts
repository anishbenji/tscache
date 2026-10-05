import { describe, expect, it } from "vitest";
import { SegmentStore, type SlotWarning } from "../src/engine/merge";
import { resolveCacheConfig } from "../src/engine/validate";
import type { Columns } from "../src/segment/types";
import { expectRows, points, store } from "./merge-test-helpers";

describe("SlotWarning — architecture §2.2, §4.3, starter §3.1", () => {
  it.each([
    false,
    undefined,
  ])("warnings are off for warnOnOverlapDiff=%j while new values still win", (enabled) => {
    const config = resolveCacheConfig({
      id: "off",
      interval: 1,
      fields: { price: "f64", volume: "i16" },
      ...(enabled === undefined ? {} : { warnOnOverlapDiff: enabled }),
    });
    const s = new SegmentStore(config);
    expect(s.put(points([0, 8], [10, 80]))).toEqual([]);
    expect(s.put(points([0, 8], [11, 81]))).toEqual([]);
    expectRows(s, [0, 8], [11, 81]);
  });

  it("reports changed fields at one overlapping slot in slot terms", () => {
    const s = store({ warnOnOverlapDiff: true });
    s.put(points([-1], [10], [1]));
    const warnings: SlotWarning[] = s.put(points([-1], [11], [2]));
    expect(warnings).toEqual([
      { range: { start: -1, end: -1 }, fields: ["price", "volume"] },
    ]);
    expectRows(s, [-1], [11], [2]);
  });

  it("groups consecutive differing batch points across gaps, segments, and pages", () => {
    const s = store({ warnOnOverlapDiff: true });
    s.put(points([-9, -1, 0, 7, 8, 20]));
    expect(s.put(points([-9, -1, 0, 7, 8, 20], [1, 2, 3, 4, 5, 6]))).toEqual([
      { range: { start: -9, end: 20 }, fields: ["price"] },
    ]);
  });

  it("unchanged overlaps and newly inserted points break warning runs", () => {
    const s = store({ warnOnOverlapDiff: true });
    s.put(points([0, 1, 2, 4, 5, 6]));
    expect(
      s.put(points([0, 1, 2, 3, 4, 5, 6], [10, 1, 20, 30, 40, 50, 6])),
    ).toEqual([
      { range: { start: 0, end: 0 }, fields: ["price"] },
      { range: { start: 2, end: 2 }, fields: ["price"] },
      { range: { start: 4, end: 5 }, fields: ["price"] },
    ]);
  });

  it("unions fields over a run in schema order, independently of input field order", () => {
    const config = resolveCacheConfig({
      id: "order",
      interval: 1,
      fields: { z: "f64", a: "f64", m: "f64" },
      warnOnOverlapDiff: true,
    });
    const s = new SegmentStore(config);
    s.put({
      slots: new Float64Array([0, 5]),
      fields: {
        m: new Float64Array([1, 1]),
        a: new Float64Array([1, 1]),
        z: new Float64Array([1, 1]),
      },
    });
    expect(
      s.put({
        slots: new Float64Array([0, 5]),
        fields: {
          m: new Float64Array([2, 2]),
          a: new Float64Array([2, 1]),
          z: new Float64Array([1, 2]),
        },
      }),
    ).toEqual([{ range: { start: 0, end: 5 }, fields: ["z", "a", "m"] }]);
  });

  it("compares after dtype conversion on both initial and overlapping writes", () => {
    const config = resolveCacheConfig({
      id: "conversion",
      interval: 1,
      fields: { f: "f32", i: "i32", u: "u8" },
      warnOnOverlapDiff: true,
    });
    const s = new SegmentStore(config);
    const input = (f: number, i: number, u: number): Columns => ({
      slots: new Float64Array([0]),
      fields: {
        f: new Float64Array([f]),
        i: new Float64Array([i]),
        u: new Float64Array([u]),
      },
    });
    s.put(input(1.1, 1.9, 257));
    expect(s.put(input(Math.fround(1.1), 1.1, 1))).toEqual([]);
    expect(s.segments[0]?.lookup(0)).toEqual({
      f: Math.fround(1.1),
      i: 1,
      u: 1,
    });
    expect(s.put(input(1.2, 2.9, 258))).toEqual([
      { range: { start: 0, end: 0 }, fields: ["f", "i", "u"] },
    ]);
  });

  it("NaN equals NaN, signed zeros compare equal, and NaN-to-number changes differ", () => {
    const s = store({ warnOnOverlapDiff: true });
    s.put(points([0, 1, 2, 3], [Number.NaN, Number.NaN, 10, -0], [0, 0, 0, 0]));
    expect(
      s.put(
        points([0, 1, 2, 3], [Number.NaN, 10, Number.NaN, 0], [0, 0, 0, 0]),
      ),
    ).toEqual([{ range: { start: 1, end: 2 }, fields: ["price"] }]);
    expectRows(s, [0, 1, 2, 3], [Number.NaN, 10, Number.NaN, 0], [0, 0, 0, 0]);
  });

  it("NaN assigned to an integer field compares as its stored zero", () => {
    const s = store({ warnOnOverlapDiff: true });
    s.put(points([0], [10], [0]));
    expect(s.put(points([0], [10], [Number.NaN]))).toEqual([]);
    expectRows(s, [0], [10], [0]);
  });

  it("replace compares incoming overlaps against old rows but never warns for deletions", () => {
    const s = store({ warnOnOverlapDiff: true });
    s.put(points([-1, 0, 1, 7, 8, 9]));
    expect(s.put(points([0, 8], [10, 80]), { start: -1, end: 9 })).toEqual([
      { range: { start: 0, end: 8 }, fields: ["price"] },
    ]);
    expectRows(s, [0, 8], [10, 80]);
    expect(s.put(points([]), { start: 0, end: 8 })).toEqual([]);
    expect(s.segments).toEqual([]);
  });

  it("new points and unchanged replacements emit no warning", () => {
    const s = store({ warnOnOverlapDiff: true });
    expect(s.put(points([0, 8]))).toEqual([]);
    expect(s.put(points([0, 8]), { start: -10, end: 20 })).toEqual([]);
    expect(s.put(points([]))).toEqual([]);
  });
});
