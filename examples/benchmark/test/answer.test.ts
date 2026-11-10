import { describe, expect, it } from "vitest";
import { barsOf, drawable } from "../src/answer";

const range = { start: 0, end: 120_000 };
const timestamps = Float64Array.from([0, 60_000, 120_000]);
const close = Float64Array.from([1, 2, 3]);

describe("barsOf", () => {
  it("gives the chart the answer's times and closes", () => {
    const bars = barsOf({ timestamps, fields: { close }, misses: [] }, range);
    expect(bars.timestamps).toBe(timestamps);
    expect(bars.close).toBe(close);
  });

  it("rejects an answer with misses, naming each reason", () => {
    // A failed fetch resolves get() with what the cache held and a miss.
    const misses = [
      {
        range,
        reason: "fetch-failed" as const,
        error: { name: "Error", message: "the backend answered 500" },
      },
    ];
    expect(() =>
      barsOf({ timestamps: new Float64Array(), fields: {}, misses }, range),
    ).toThrow(/fetch-failed.*the backend answered 500/);
  });
});

describe("drawable", () => {
  it("passes a view with bars, in every mode", () => {
    expect(drawable({ timestamps, close }, range)).toEqual({
      timestamps,
      close,
    });
  });

  it("rejects a view with no bars: the workload's ranges all have some", () => {
    expect(() => drawable({ timestamps: [], close: [] }, range)).toThrow(
      /no bars/,
    );
  });
});
