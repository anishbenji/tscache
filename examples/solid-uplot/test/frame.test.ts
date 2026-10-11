import type { GetResult } from "tscache";
import { describe, expect, it } from "vitest";
import { toFrame } from "../src/frame";

const S = 10_000;

function result(
  timestamps: number[],
  coverage: GetResult["coverage"],
): GetResult {
  return {
    timestamps: Float64Array.from(timestamps),
    fields: {
      temperature: Float32Array.from(timestamps, (t) => t / S + 0.5),
      battery: Uint8Array.from(timestamps, (t) => t / S),
    },
    coverage,
    misses: [],
  };
}

describe("toFrame", () => {
  it("puts each point on its slot and null on every empty slot", () => {
    const frame = toFrame(
      result([2 * S, 3 * S, 6 * S], [{ start: 0, end: 8 * S }]),
      { start: S, end: 7 * S },
      S,
    );
    expect(frame.slots).toEqual([1, 2, 3, 4, 5, 6, 7].map((n) => n * S));
    expect(frame.values.temperature).toEqual([
      null,
      2.5,
      3.5,
      null,
      null,
      6.5,
      null,
    ]);
    expect(frame.values.battery).toEqual([null, 2, 3, null, null, 6, null]);
    expect(frame.points).toBe(3);
  });

  it("splits empty slots into confirmed gaps and unloaded runs by coverage", () => {
    const frame = toFrame(
      result(
        [S, 5 * S, 9 * S],
        [
          { start: 0, end: 6 * S },
          { start: 9 * S, end: 10 * S },
        ],
      ),
      { start: 0, end: 10 * S },
      S,
    );
    expect(frame.gaps).toEqual([
      { start: 0, end: 0 },
      { start: 2 * S, end: 4 * S },
      { start: 6 * S, end: 6 * S },
      { start: 10 * S, end: 10 * S },
    ]);
    expect(frame.unloaded).toEqual([{ start: 7 * S, end: 8 * S }]);
  });

  it("keeps only the slots inside an unaligned range", () => {
    const frame = toFrame(
      result([0, S, 2 * S, 3 * S], [{ start: 0, end: 3 * S }]),
      { start: 0.5 * S, end: 2.5 * S },
      S,
    );
    expect(frame.slots).toEqual([S, 2 * S]);
    expect(frame.points).toBe(2);
    expect(frame.gaps).toEqual([]);
  });
});
