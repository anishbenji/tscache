import { describe, expect, it } from "vitest";
import { SETUPS, setupOf } from "../../bench/setups";

// The bench setups of the Chromium noise experiment (docs/benchmarking.md):
// what each one changes, and that the default changes nothing.

describe("bench setups", () => {
  it("leaves Chromium, batches and rounds alone by default", () => {
    expect(setupOf("default")).toEqual({ chromiumArgs: [] });
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

  it("times 30 rounds of 100 ms batches", () => {
    expect(setupOf("long-batches")).toEqual({
      chromiumArgs: [],
      batchMs: 100,
      rounds: 30,
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
