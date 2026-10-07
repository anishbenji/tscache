import { afterEach, describe, expect, it, vi } from "vitest";
import { Engine, type EngineEvents } from "../src/engine/engine";
import { SegmentStore } from "../src/engine/merge";
import { batch, engineConfig, result } from "./engine-test-helpers";

// Implementer tests (not contract tests): a throwing listener must not stop
// clearAll from emptying and notifying every cache (N22).

describe("Engine clearAll with a throwing listener", () => {
  it("clears and notifies every cache, then rethrows the first error", () => {
    const engine = new Engine();
    engine.cache(engineConfig({ id: "a" }));
    engine.cache(engineConfig({ id: "b" }));
    engine.put("a", batch([3]));
    engine.put("b", batch([13]));
    const seen: EngineEvents["cacheCleared"][] = [];
    const failure = new Error("listener failed");
    engine.on("cacheCleared", (event) => {
      seen.push(event);
      if (event.cacheId === "a") throw failure;
    });
    expect(() => engine.clearAll()).toThrow(failure);
    expect(seen).toEqual([
      { cacheId: "a", reason: "clear-all" },
      { cacheId: "b", reason: "clear-all" },
    ]);
    for (const id of ["a", "b"]) {
      expect(engine.get(id, { start: 3, end: 13 })).toEqual(
        result([], [], [{ start: 3, end: 13 }]),
      );
    }
  });
});

describe("the './engine' package entry", () => {
  it("exports Engine and the errors a Node consumer needs", async () => {
    const entry = await import("../src/entries/engine");
    expect(typeof entry.Engine).toBe("function");
    expect(typeof entry.ConfigError).toBe("function");
    expect(typeof entry.UnknownCacheError).toBe("function");
    const engine = new entry.Engine();
    const { id } = engine.cache(engineConfig());
    engine.put(id, batch([3]));
    expect(engine.get(id, { start: 3, end: 3 })).toEqual(
      result([3], [{ start: 3, end: 3 }], []),
    );
  });
});

describe("Engine version-mismatch clear whose write fails", () => {
  afterEach(() => vi.restoreAllMocks());

  it("still emits cacheCleared once, propagates the error, and a retry emits nothing", () => {
    const engine = new Engine();
    const { id } = engine.cache(engineConfig({ version: "v1" }));
    engine.put(id, batch([3, 13]));
    const seen: EngineEvents["cacheCleared"][] = [];
    engine.on("cacheCleared", (event) => {
      seen.push(event);
      // The cache is already empty when the listener runs.
      expect(engine.get(id, { start: 3, end: 23 })).toEqual(
        result([], [], [{ start: 3, end: 23 }]),
      );
    });
    vi.spyOn(SegmentStore.prototype, "put").mockImplementationOnce(() => {
      throw new RangeError("Array buffer allocation failed");
    });
    expect(() =>
      engine.put(id, { ...batch([23]), meta: { version: "v2" } }),
    ).toThrow(RangeError);
    expect(seen).toEqual([{ cacheId: id, reason: "version-mismatch" }]);
    expect(engine.put(id, { ...batch([23]), meta: { version: "v2" } })).toEqual(
      { warnings: [] },
    );
    expect(seen).toHaveLength(1);
    expect(engine.get(id, { start: 3, end: 23 })).toEqual(
      result([23], [{ start: 23, end: 23 }], [{ start: 3, end: 13 }]),
    );
  });
});

describe("Engine version-mismatch clear whose write and listener both fail", () => {
  afterEach(() => vi.restoreAllMocks());

  it("propagates the write error, not the listener's", () => {
    const engine = new Engine();
    const { id } = engine.cache(engineConfig({ version: "v1" }));
    engine.put(id, batch([3]));
    const seen: EngineEvents["cacheCleared"][] = [];
    engine.on("cacheCleared", (event) => {
      seen.push(event);
      throw new Error("listener failed");
    });
    const failure = new RangeError("Array buffer allocation failed");
    vi.spyOn(SegmentStore.prototype, "put").mockImplementationOnce(() => {
      throw failure;
    });
    expect(() =>
      engine.put(id, { ...batch([13]), meta: { version: "v2" } }),
    ).toThrow(failure);
    expect(seen).toEqual([{ cacheId: id, reason: "version-mismatch" }]);
    expect(engine.get(id, { start: 3, end: 13 })).toEqual(
      result([], [], [{ start: 3, end: 13 }]),
    );
  });
});
