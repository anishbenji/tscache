import { describe, expect, it } from "vitest";
import { CoverageIndex } from "../src/coverage";
import { collect, read } from "../src/engine/read";
import type { Grid } from "../src/grid";
import { points, schema, store } from "./merge-test-helpers";

const grid: Grid = { interval: 10, alignmentOffset: 3 };
const invalid = [
  0.5,
  -0.5,
  Number.NaN,
  Infinity,
  -Infinity,
  2 ** 53,
  -(2 ** 53),
];

describe("malformed read requests — architecture §4.1, §4.4", () => {
  it.each([
    { start: 1, end: 0 },
    ...invalid.flatMap((slot) => [
      { start: slot, end: 20 },
      { start: -20, end: slot },
    ]),
  ])(
    "collect and read throw RangeError for %j even without segments",
    (request) => {
      for (const populated of [false, true]) {
        const s = store();
        const index = new CoverageIndex();
        if (populated) {
          s.put(points([-1, 0, 8]));
          index.add({ start: -2, end: 10 });
        }

        expect(() => collect(s.segments, request, schema)).toThrow(RangeError);
        expect(() => read(request, s.segments, index, grid, schema)).toThrow(
          RangeError,
        );
      }
    },
  );

  it.each([Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER])(
    "accepts the safe single-slot boundary %i",
    (slot) => {
      const exactGrid: Grid = { interval: 1, alignmentOffset: 0 };
      const s = store({ ...exactGrid, segmentSlotCap: 1 });
      s.put(points([slot], [42], [4]));
      const index = new CoverageIndex();
      index.add({ start: slot, end: slot });
      const request = { start: slot, end: slot };

      expect(collect(s.segments, request, schema)).toEqual({
        slots: new Float64Array([slot]),
        fields: { price: new Float64Array([42]), volume: new Int16Array([4]) },
      });
      expect(read(request, s.segments, index, exactGrid, schema)).toEqual({
        timestamps: new Float64Array([slot]),
        fields: { price: new Float64Array([42]), volume: new Int16Array([4]) },
        coverage: [{ start: slot, end: slot }],
        misses: [],
      });
    },
  );
});
