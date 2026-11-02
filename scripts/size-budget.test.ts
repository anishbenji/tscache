import { describe, expect, it } from "vitest";
import { budgetFor, checkRow, parseBudgets } from "./size-budget";

describe("checkRow", () => {
  it("compares a row with its committed budget", () => {
    expect(checkRow("check", { index: 5008 }, "index", 4500)).toEqual({
      status: "ok",
      budget: 5008,
    });
    expect(checkRow("check", { index: 5008 }, "index", 5009)).toEqual({
      status: "over",
      budget: 5008,
    });
  });

  it("reports a row without a committed budget as missing, whatever its size (R1-1)", () => {
    // A new lazy chunk must not pass on a budget derived from its own size.
    expect(checkRow("check", { index: 5008 }, "worker:lazy", 1)).toEqual({
      status: "missing",
    });
    expect(checkRow("check", {}, "index", 1)).toEqual({ status: "missing" });
  });

  it("derives budgets only when writing them (--update)", () => {
    expect(checkRow("update", {}, "worker:lazy", 5303)).toEqual({
      status: "ok",
      budget: budgetFor(5303),
    });
    expect(budgetFor(5303)).toBe(5824);
  });
});

describe("parseBudgets", () => {
  it("reads the committed brotli table", () => {
    expect(parseBudgets('{ "brotli": { "index": 5008 } }')).toEqual({
      index: 5008,
    });
  });

  it("rejects an absent or malformed table instead of checking against derived budgets (R2-1)", () => {
    for (const text of [
      "{}",
      '{ "gzip": { "index": 5008 } }',
      '{ "brotli": null }',
      '{ "brotli": [5008] }',
      '{ "brotli": { "index": "5008" } }',
      "null",
    ]) {
      expect(() => parseBudgets(text), text).toThrow(/no "brotli" table/);
    }
  });

  it("checks every row of a parsed empty table as missing (R2-1, the caller path)", () => {
    const budgets = parseBudgets('{ "brotli": {} }');
    expect(checkRow("check", budgets, "index", 999_999)).toEqual({
      status: "missing",
    });
  });
});
