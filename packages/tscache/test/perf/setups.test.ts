import { describe, expect, it } from "vitest";
import { SETUPS, setupOf } from "../../bench/setups";

// The bench setups of the Chromium noise experiment (docs/benchmarking.md):
// what each one changes. The default times 30 rounds of 100 ms batches,
// which kept Chromium's A/A control quiet in 19 of 20 runs on GitHub's
// runner, against 15 of 20 with 40 ms batches and 20 rounds.

describe("bench setups", () => {
  it("times 30 rounds of 100 ms batches by default, Chromium as launched", () => {
    expect(setupOf("default")).toEqual({
      chromiumArgs: [],
      batchMs: 100,
      rounds: 30,
    });
  });

  it("keeps the earlier 40 ms batches and 20 rounds for comparison", () => {
    expect(setupOf("short-batches")).toEqual({
      chromiumArgs: [],
      batchMs: 40,
      rounds: 20,
    });
  });

  it("stops Chromium deprioritising the page", () => {
    expect(setupOf("unthrottled")).toEqual({
      chromiumArgs: [
        "--disable-renderer-backgrounding",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
      ],
    });
  });

  it("limits Chromium to one renderer process", () => {
    expect(setupOf("one-renderer")).toEqual({
      chromiumArgs: ["--renderer-process-limit=1"],
    });
  });

  it("combines the three", () => {
    const { unthrottled, "one-renderer": oneRenderer } = SETUPS;
    expect(setupOf("combined")).toEqual({
      chromiumArgs: [...unthrottled.chromiumArgs, ...oneRenderer.chromiumArgs],
      batchMs: 100,
      rounds: 30,
    });
  });

  it("refuses a name it does not know, including inherited ones", () => {
    expect(() => setupOf("fast")).toThrow(/--setup must be one of default/);
    expect(() => setupOf("toString")).toThrow(/not toString/);
  });
});
