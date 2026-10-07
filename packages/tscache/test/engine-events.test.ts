import { describe, expect, expectTypeOf, it } from "vitest";
import { Engine, type EngineEvents } from "../src/engine/engine";
import { batch, engineConfig, result } from "./engine-test-helpers";

describe("Engine events — architecture §2.7, §4.6, N5, N21–N22", () => {
  it("EngineEvents contains exactly the cache-scoped cacheCleared payload", () => {
    expectTypeOf<keyof EngineEvents>().toEqualTypeOf<"cacheCleared">();
    expectTypeOf<EngineEvents["cacheCleared"]>().toEqualTypeOf<{
      cacheId: string;
      reason: "manual" | "clear-all" | "version-mismatch";
    }>();
  });

  it("clear emits exactly the manual payload synchronously after clearing", () => {
    const engine = new Engine();
    const { id } = engine.cache(engineConfig());
    engine.put(id, batch([3, 13]));
    const seen: EngineEvents["cacheCleared"][] = [];
    engine.on("cacheCleared", (event) => {
      expect(Reflect.ownKeys(event).sort()).toEqual(["cacheId", "reason"]);
      seen.push(event);
      expect(engine.get(event.cacheId, { start: 3, end: 23 })).toEqual(
        result([], [], [{ start: 3, end: 23 }]),
      );
    });
    engine.clear(id);
    expect(seen).toEqual([{ cacheId: id, reason: "manual" }]);
  });

  it("version-mismatch emits after put applied, so its listener sees the new data", () => {
    const engine = new Engine();
    const { id } = engine.cache(engineConfig({ version: "v1" }));
    engine.put(id, batch([3, 13]));
    const seen: EngineEvents["cacheCleared"][] = [];
    engine.on("cacheCleared", (event) => {
      expect(Reflect.ownKeys(event).sort()).toEqual(["cacheId", "reason"]);
      seen.push(event);
      expect(engine.get(event.cacheId, { start: 3, end: 33 })).toEqual(
        result([23], [{ start: 13, end: 33 }], [{ start: 3, end: 3 }], [230]),
      );
    });
    const put = engine.put(
      id,
      { ...batch([23], [230]), meta: { version: "v2" } },
      { range: { start: 13, end: 33 } },
    );
    expect(put).toEqual({ warnings: [] });
    expect(Reflect.ownKeys(put)).toEqual(["warnings"]);
    expect(put).not.toHaveProperty("cleared");
    expect(seen).toEqual([{ cacheId: id, reason: "version-mismatch" }]);
    expect(
      engine.put(
        id,
        { ...batch([23], [230]), meta: { version: "v2" } },
        { range: { start: 13, end: 33 } },
      ),
    ).toEqual({ warnings: [] });
    expect(seen).toEqual([{ cacheId: id, reason: "version-mismatch" }]);
  });

  it("an empty version-mismatched put also emits once and returns only warnings", () => {
    const engine = new Engine();
    const { id } = engine.cache(engineConfig({ version: "v1" }));
    engine.put(id, batch([3, 13]));
    const seen: EngineEvents["cacheCleared"][] = [];
    engine.on("cacheCleared", (event) => seen.push(event));
    expect(engine.put(id, { ...batch([]), meta: { version: "v2" } })).toEqual({
      warnings: [],
    });
    expect(seen).toEqual([{ cacheId: id, reason: "version-mismatch" }]);
    expect(engine.get(id, { start: 3, end: 23 })).toEqual(
      result([], [], [{ start: 3, end: 23 }]),
    );
  });

  it("first version adoption, omitted version, get, invalidate and watermark updates emit no clears", () => {
    const engine = new Engine();
    const { id } = engine.cache(engineConfig());
    const seen: EngineEvents["cacheCleared"][] = [];
    engine.on("cacheCleared", (event) => seen.push(event));
    engine.put(id, batch([3]));
    engine.put(id, { ...batch([13]), meta: { version: "first" } });
    engine.put(id, { ...batch([23]), meta: { version: "first" } });
    engine.put(id, batch([33]));
    expect(engine.get(id, { start: 3, end: 33 })).toEqual(
      result([3, 13, 23, 33], [{ start: 3, end: 33 }], []),
    );
    engine.invalidate(id, { start: 13, end: 13 });
    engine.setFinalizedUntil(id, 23);
    expect(seen).toEqual([]);
  });

  it.each(["unsubscribe", "off"] as const)(
    "%s stops an engine listener and leaves other listeners active",
    (method) => {
      const engine = new Engine();
      const { id } = engine.cache(engineConfig());
      const removed: EngineEvents["cacheCleared"][] = [];
      const kept: EngineEvents["cacheCleared"][] = [];
      const listener = (event: EngineEvents["cacheCleared"]) =>
        removed.push(event);
      const unsubscribe = engine.on("cacheCleared", listener);
      engine.on("cacheCleared", (event) => kept.push(event));
      engine.clear(id);
      if (method === "unsubscribe") unsubscribe();
      else engine.off("cacheCleared", listener);
      engine.clear(id);
      engine.clearAll();
      expect(removed).toEqual([{ cacheId: id, reason: "manual" }]);
      expect(kept).toEqual([
        { cacheId: id, reason: "manual" },
        { cacheId: id, reason: "manual" },
        { cacheId: id, reason: "clear-all" },
      ]);
    },
  );

  it("a listener hears other caches with their own ids and clear does not affect its peers", () => {
    const engine = new Engine();
    engine.cache(engineConfig({ id: "a" }));
    engine.cache(engineConfig({ id: "b", version: "v1" }));
    engine.put("a", batch([3]));
    engine.put("b", batch([13]));
    const seen: EngineEvents["cacheCleared"][] = [];
    engine.on("cacheCleared", (event) => seen.push(event));
    engine.clear("a");
    expect(engine.get("b", { start: 3, end: 23 })).toEqual(
      result(
        [13],
        [{ start: 13, end: 13 }],
        [
          { start: 3, end: 3 },
          { start: 23, end: 23 },
        ],
      ),
    );
    engine.put("a", batch([3]));
    engine.put("b", { ...batch([23]), meta: { version: "v2" } });
    expect(engine.get("a", { start: 3, end: 3 })).toEqual(
      result([3], [{ start: 3, end: 3 }], []),
    );
    expect(seen).toEqual([
      { cacheId: "a", reason: "manual" },
      { cacheId: "b", reason: "version-mismatch" },
    ]);
  });

  it("clearAll emits once per cache in creation order, including already-empty caches", () => {
    const engine = new Engine();
    for (const id of ["z", "a", "m"]) engine.cache(engineConfig({ id }));
    engine.cache(engineConfig({ id: "z" }));
    engine.put("a", batch([3]));
    engine.clear("a");
    engine.put("m", batch([13]));
    const seen: EngineEvents["cacheCleared"][] = [];
    engine.on("cacheCleared", (event) => {
      expect(Reflect.ownKeys(event).sort()).toEqual(["cacheId", "reason"]);
      seen.push(event);
      expect(engine.get(event.cacheId, { start: 3, end: 23 })).toEqual(
        result([], [], [{ start: 3, end: 23 }]),
      );
    });
    engine.clearAll();
    expect(seen).toEqual([
      { cacheId: "z", reason: "clear-all" },
      { cacheId: "a", reason: "clear-all" },
      { cacheId: "m", reason: "clear-all" },
    ]);
  });

  it("clearAll on an engine with no caches emits nothing", () => {
    const engine = new Engine();
    const seen: EngineEvents["cacheCleared"][] = [];
    engine.on("cacheCleared", (event) => seen.push(event));
    engine.clearAll();
    engine.clearAll();
    expect(seen).toEqual([]);
  });
});
