import { describe, expect, it, vi } from "vitest";
import { Engine, type EngineEvents } from "../src/engine/engine";
import { batch, engineConfig, result } from "./engine-test-helpers";

describe("Engine in-process lifecycle — architecture §2.1–§2.4, §4.5–§4.6, §5", () => {
  it("creates, puts, reads, invalidates, refills, finalizes, bumps version and clears all end-to-end", () => {
    const engine = new Engine();
    const { id } = engine.cache(
      engineConfig({ version: "v1", finalizedUntil: 33 }),
    );
    const range = { start: -7, end: 53 };
    const seen: EngineEvents["cacheCleared"][] = [];
    engine.on("cacheCleared", (event) => seen.push(event));
    expect(engine.get(id, range)).toEqual(result([], [], [range]));

    expect(engine.put(id, batch([3, 23, 33, 43]), { range })).toEqual({
      warnings: [],
    });
    expect(engine.get(id, range)).toEqual(
      result(
        [3, 23, 33, 43],
        [{ start: -7, end: 23 }],
        [{ start: 33, end: 53 }],
      ),
    );

    // 13 floors to itself and 22.5 ceils to 23 (N1): slots 13..23 forgotten.
    // (The test first used start 12.5, which floors to 3; corrected to match
    // §4.1, see docs/reviews/step-08.md.)
    engine.invalidate(id, { start: 13, end: 22.5 });
    expect(engine.get(id, range)).toEqual(
      result(
        [3, 23, 33, 43],
        [{ start: -7, end: 3 }],
        [{ start: 13, end: 53 }],
      ),
    );

    expect(
      engine.put(id, batch([13], [130]), { range: { start: 13, end: 23 } }),
    ).toEqual({ warnings: [] });
    expect(engine.get(id, range)).toEqual(
      result(
        [3, 13, 33, 43],
        [{ start: -7, end: 23 }],
        [{ start: 33, end: 53 }],
        [3, 130, 33, 43],
      ),
    );

    engine.setFinalizedUntil(id, 53);
    expect(engine.get(id, range)).toEqual(
      result(
        [3, 13, 33, 43],
        [{ start: -7, end: 23 }],
        [{ start: 33, end: 53 }],
        [3, 130, 33, 43],
      ),
    );

    expect(
      engine.put(id, batch([33, 43], [330, 430]), {
        range: { start: 33, end: 53 },
      }),
    ).toEqual({ warnings: [] });
    expect(engine.get(id, range)).toEqual(
      result(
        [3, 13, 33, 43],
        [{ start: -7, end: 43 }],
        [{ start: 53, end: 53 }],
        [3, 130, 330, 430],
      ),
    );

    expect(
      engine.put(
        id,
        { ...batch([13, 53], [131, 531]), meta: { version: "v2" } },
        { range },
      ),
    ).toEqual({ warnings: [] });
    expect(engine.get(id, range)).toEqual(
      result(
        [13, 53],
        [{ start: -7, end: 43 }],
        [{ start: 53, end: 53 }],
        [131, 531],
      ),
    );

    engine.clearAll();
    expect(engine.get(id, range)).toEqual(result([], [], [range]));
    expect(engine.has(id)).toBe(true);
    expect(seen).toEqual([
      { cacheId: id, reason: "version-mismatch" },
      { cacheId: id, reason: "clear-all" },
    ]);
  });

  it.each(["clear", "clearAll"] as const)(
    "%s preserves configs, current versions and current watermarks so existing ids remain usable",
    (method) => {
      const engine = new Engine();
      const configs = [
        engineConfig({
          id: "a",
          version: "v1",
          finalizedUntil: 23,
          gapSplitK: 2,
          segmentSlotCap: 4,
          warnOnOverlapDiff: true,
        }),
        engineConfig({ id: "b", version: "v1", finalizedUntil: 23 }),
      ];
      const range = { start: 3, end: 53 };
      for (const config of configs) {
        engine.cache(config);
        engine.put(config.id, {
          ...batch([3, 13, 23]),
          meta: { version: "v2", finalizedUntil: 43 },
        });
      }
      if (method === "clearAll") engine.clearAll();
      else for (const config of configs) engine.clear(config.id);
      const seen: EngineEvents["cacheCleared"][] = [];
      engine.on("cacheCleared", (event) => seen.push(event));
      for (const config of configs) {
        expect(engine.has(config.id)).toBe(true);
        expect(engine.get(config.id, range)).toEqual(result([], [], [range]));
        // Rejoining with the original structure must still be accepted; the
        // old initial dataset metadata cannot change the current state.
        expect(engine.cache(config)).toMatchObject({
          id: config.id,
          interval: 10,
          alignmentOffset: 3,
          fields: { price: "f64", volume: "i16" },
          gapSplitK: config.gapSplitK ?? 4,
          segmentSlotCap: config.segmentSlotCap ?? 32_768,
          warnOnOverlapDiff: config.warnOnOverlapDiff ?? false,
        });
        engine.put(config.id, {
          ...batch([3, 33, 43]),
          meta: { version: "v2" },
        });
        engine.put(config.id, { ...batch([13]), meta: { version: "v2" } });
        expect(engine.get(config.id, range)).toEqual(
          result(
            [3, 13, 33, 43],
            [{ start: 3, end: 33 }],
            [{ start: 43, end: 53 }],
          ),
        );
        engine.invalidate(config.id, { start: 13, end: 13 });
        engine.put(config.id, batch([13], [130]));
        expect(engine.get(config.id, range)).toEqual(
          result(
            [3, 13, 33, 43],
            [{ start: 3, end: 33 }],
            [{ start: 43, end: 53 }],
            [3, 130, 33, 43],
          ),
        );
        engine.setFinalizedUntil(config.id, 33);
        expect(engine.get(config.id, range)).toEqual(
          result(
            [3, 13, 33, 43],
            [{ start: 3, end: 23 }],
            [{ start: 33, end: 53 }],
            [3, 130, 33, 43],
          ),
        );
      }
      expect(seen).toEqual([]);
    },
  );

  it("two ids with different grids and schemas keep writes, invalidation and watermarks independent", () => {
    const engine = new Engine();
    engine.cache(engineConfig({ id: "fast", finalizedUntil: 33 }));
    engine.cache({
      id: "slow",
      interval: 20,
      alignmentOffset: 5,
      fields: { count: "u32" },
    });
    engine.put("fast", batch([3, 13, 23, 33]));
    engine.put(
      "slow",
      { timestamps: [5, 45], fields: { count: [7, 9] } },
      { range: { start: 5, end: 65 } },
    );
    const slow = {
      timestamps: new Float64Array([5, 45]),
      fields: { count: new Uint32Array([7, 9]) },
      coverage: [{ start: 5, end: 65 }],
      misses: [],
    };
    engine.invalidate("fast", { start: 13, end: 23 });
    engine.setFinalizedUntil("fast", 13);
    expect(engine.get("fast", { start: 3, end: 33 })).toEqual(
      result([3, 13, 23, 33], [{ start: 3, end: 3 }], [{ start: 13, end: 33 }]),
    );
    expect(engine.get("slow", { start: 5, end: 65 })).toEqual(slow);
    engine.clear("fast");
    expect(engine.get("slow", { start: 5, end: 65 })).toEqual(slow);
    engine.put("fast", batch([3]));
    engine.clear("slow");
    expect(engine.get("fast", { start: 3, end: 13 })).toEqual(
      result([3], [{ start: 3, end: 3 }], [{ start: 13, end: 13 }]),
    );
    expect(engine.get("slow", { start: 5, end: 65 })).toEqual({
      timestamps: new Float64Array(),
      fields: { count: new Uint32Array() },
      coverage: [],
      misses: [{ range: { start: 5, end: 65 }, reason: "uncached" }],
    });
  });

  it("a fresh module import and operations work under Node without DOM or worker globals", async () => {
    expect(typeof globalThis.SharedWorker).toBe("undefined");
    expect(typeof globalThis.Worker).toBe("undefined");
    expect(typeof globalThis.document).toBe("undefined");
    vi.resetModules();
    const { Engine: NodeEngine } = await import("../src/engine/engine");
    const engine = new NodeEngine();
    const { id } = engine.cache(engineConfig());
    engine.put(id, batch([3, 13]));
    expect(engine.get(id, { start: 3, end: 23 })).toEqual(
      result([3, 13], [{ start: 3, end: 13 }], [{ start: 23, end: 23 }]),
    );
    engine.invalidate(id, { start: 13, end: 13 });
    engine.setFinalizedUntil(id, 13);
    engine.clear(id);
    engine.clearAll();
    expect(engine.has(id)).toBe(true);
    expect(typeof globalThis.SharedWorker).toBe("undefined");
    expect(typeof globalThis.Worker).toBe("undefined");
    expect(typeof globalThis.document).toBe("undefined");
  });
});
