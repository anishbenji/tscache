import { describe, expect, it } from "vitest";
import { budgetFor, checkRow } from "./size-budget";

describe("checkRow", () => {
  it("compares a row with its committed budget", () => {
    expect(checkRow({ index: 5008 }, "index", 4500)).toEqual({
      status: "ok",
      budget: 5008,
    });
    expect(checkRow({ index: 5008 }, "index", 5009)).toEqual({
      status: "over",
      budget: 5008,
    });
  });

  it("reports a row without a committed budget as missing, whatever its size (R1-1)", () => {
    // A new lazy chunk must not pass on a budget derived from its own size.
    expect(checkRow({ index: 5008 }, "worker:lazy", 1)).toEqual({
      status: "missing",
    });
    expect(checkRow({}, "index", 1)).toEqual({ status: "missing" });
  });

  it("derives budgets only when writing them (--update)", () => {
    expect(checkRow(undefined, "worker:lazy", 5303)).toEqual({
      status: "ok",
      budget: budgetFor(5303),
    });
    expect(budgetFor(5303)).toBe(5824);
  });
});
