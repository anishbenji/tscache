import { describe, expect, it } from "vitest";
import { CoverageIndex } from "../src/coverage";

// Implementer tests (not contract tests): architecture §4.1 ownership rule.
describe("CoverageIndex never shares range objects with its callers", () => {
  it("does not keep the object passed to add", () => {
    const index = new CoverageIndex();
    const input = { start: 1, end: 5 };
    index.add(input);
    input.start = -100;
    input.end = 100;
    expect(index.ranges()).toEqual([{ start: 1, end: 5 }]);
  });

  it("returns fresh objects from covered and gaps", () => {
    const index = new CoverageIndex();
    index.add({ start: 1, end: 5 });
    const query = { start: 1, end: 9 };
    const covered = index.covered(query);
    const gaps = index.gaps(query);
    for (const range of [...covered, ...gaps]) {
      expect(range).not.toBe(query);
      range.start = -100;
      range.end = 100;
    }
    expect(query).toEqual({ start: 1, end: 9 });
    expect(index.ranges()).toEqual([{ start: 1, end: 5 }]);
    expect(index.covered(query)).toEqual([{ start: 1, end: 5 }]);
    expect(index.gaps(query)).toEqual([{ start: 6, end: 9 }]);
  });
});
