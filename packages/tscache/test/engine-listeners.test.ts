import { describe, expect, it } from "vitest";
import { Engine, type EngineEvents } from "../src/engine/engine";
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
