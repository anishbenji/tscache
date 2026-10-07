import { describe, expect, expectTypeOf, it } from "vitest";
import { Engine, type EngineEvents } from "../src/engine/engine";
import { ConfigError, UnknownCacheError } from "../src/errors";
import type { CacheConfig, ResolvedCacheConfig } from "../src/types";
import { batch, engineConfig, result } from "./engine-test-helpers";

describe("Engine cache get-or-create — architecture §2.2, §4.6, N4, N20", () => {
  it("creates a fresh id and returns its resolved config with defaults", () => {
    const engine = new Engine();
    const resolved = engine.cache({
      id: "fresh",
      interval: 10,
      fields: { price: "f64", volume: "i16" },
    });
    expectTypeOf(resolved).toEqualTypeOf<ResolvedCacheConfig>();
    expect(resolved).toEqual({
      id: "fresh",
      interval: 10,
      alignmentOffset: 0,
      fields: { price: "f64", volume: "i16" },
      gapSplitK: 4,
      segmentSlotCap: 32_768,
      warnOnOverlapDiff: false,
    });
    expect(engine.has("fresh")).toBe(true);
    expect(engine.get("fresh", { start: 0, end: 20 })).toEqual(
      result([], [], [{ start: 0, end: 20 }]),
    );
  });

  it("returns the creator's resolved dataset metadata when a tab joins with different metadata", () => {
    const engine = new Engine();
    const config = engineConfig({ version: "v1", finalizedUntil: 23 });
    const live = engine.cache(config);
    expect(live).toEqual({
      id: "contract-08",
      interval: 10,
      alignmentOffset: 3,
      fields: { price: "f64", volume: "i16" },
      gapSplitK: 4,
      segmentSlotCap: 32_768,
      warnOnOverlapDiff: false,
      version: "v1",
      finalizedUntil: 23,
    });
    expect(
      engine.cache({ ...config, version: "old", finalizedUntil: 13 }),
    ).toEqual(live);
  });

  it.each([-7, 3, 13, 23])(
    "joins with reordered fields, explicit defaults and normalized offset %i without losing data",
    (alignmentOffset) => {
      const engine = new Engine();
      const config = engineConfig({ alignmentOffset: 13 });
      const live = engine.cache(config);
      engine.put(config.id, batch([3, 13]));
      expect(engine.cache(config)).toEqual(live);
      expect(
        engine.cache({
          ...config,
          alignmentOffset,
          fields: { volume: "i16", price: "f64" },
          gapSplitK: 4,
          segmentSlotCap: 32_768,
          warnOnOverlapDiff: false,
        }),
      ).toEqual(live);
      expect(engine.get(config.id, { start: 3, end: 23 })).toEqual(
        result([3, 13], [{ start: 3, end: 13 }], [{ start: 23, end: 23 }]),
      );
    },
  );

  const conflicts: {
    name: string;
    field: string;
    change: Partial<CacheConfig>;
  }[] = [
    { name: "interval", field: "interval", change: { interval: 20 } },
    {
      name: "alignmentOffset",
      field: "alignmentOffset",
      change: { alignmentOffset: 4 },
    },
    {
      name: "missing field",
      field: "fields",
      change: { fields: { price: "f64" } },
    },
    {
      name: "extra field",
      field: "fields",
      change: { fields: { price: "f64", volume: "i16", extra: "f32" } },
    },
    {
      name: "renamed field",
      field: "fields",
      change: { fields: { price: "f64", count: "i16" } },
    },
    {
      name: "changed dtype",
      field: "fields",
      change: { fields: { price: "f32", volume: "i16" } },
    },
    { name: "gapSplitK", field: "gapSplitK", change: { gapSplitK: 5 } },
    {
      name: "segmentSlotCap",
      field: "segmentSlotCap",
      change: { segmentSlotCap: 16 },
    },
    {
      name: "warnOnOverlapDiff",
      field: "warnOnOverlapDiff",
      change: { warnOnOverlapDiff: true },
    },
  ];

  it.each(conflicts)(
    "$name mismatch names the field and leaves the live cache untouched",
    ({ field, change }) => {
      const engine = new Engine();
      const config = engineConfig({ version: "v1", finalizedUntil: 33 });
      const live = engine.cache(config);
      engine.put(config.id, batch([3, 13, 23, 33]));
      const events: EngineEvents["cacheCleared"][] = [];
      engine.on("cacheCleared", (event) => events.push(event));
      const before = engine.get(config.id, { start: 3, end: 43 });
      const conflicting = {
        ...config,
        ...change,
        version: "v2",
        finalizedUntil: 53,
      };
      expect(() => engine.cache(conflicting)).toThrow(ConfigError);
      expect(() => engine.cache(conflicting)).toThrow(new RegExp(field));
      expect(engine.cache(config)).toEqual(live);
      expect(engine.get(config.id, { start: 3, end: 43 })).toEqual(before);
      engine.put(config.id, { ...batch([43]), meta: { version: "v1" } });
      expect(engine.get(config.id, { start: 3, end: 43 })).toEqual(
        result(
          [3, 13, 23, 33, 43],
          [{ start: 3, end: 23 }],
          [{ start: 33, end: 43 }],
        ),
      );
      expect(events).toEqual([]);
    },
  );

  it("a joining tab's different version cannot clear or replace the live version", () => {
    const engine = new Engine();
    const config = engineConfig({ version: "v1" });
    engine.cache(config);
    engine.put(config.id, { ...batch([3]), meta: { version: "v2" } });
    const events: EngineEvents["cacheCleared"][] = [];
    engine.on("cacheCleared", (event) => events.push(event));
    engine.cache({ ...config, version: "old-deploy" });
    expect(engine.get(config.id, { start: 3, end: 13 })).toEqual(
      result([3], [{ start: 3, end: 3 }], [{ start: 13, end: 13 }]),
    );
    engine.put(config.id, { ...batch([13]), meta: { version: "v2" } });
    expect(engine.get(config.id, { start: 3, end: 13 })).toEqual(
      result([3, 13], [{ start: 3, end: 13 }], []),
    );
    expect(events).toEqual([]);
  });

  it.each([13, 73])(
    "a joining tab's finalizedUntil=%i cannot move the live watermark",
    (finalizedUntil) => {
      const engine = new Engine();
      const config = engineConfig({ finalizedUntil: 23 });
      engine.cache(config);
      engine.setFinalizedUntil(config.id, 43);
      engine.put(config.id, batch([3, 13, 23, 33, 43]));
      const before = engine.get(config.id, { start: 3, end: 53 });
      engine.cache({ ...config, finalizedUntil });
      expect(engine.get(config.id, { start: 3, end: 53 })).toEqual(before);
      engine.put(config.id, batch([33, 43, 53], [330, 430, 530]));
      expect(engine.get(config.id, { start: 3, end: 53 })).toEqual(
        result(
          [3, 13, 23, 33, 43, 53],
          [{ start: 3, end: 33 }],
          [{ start: 43, end: 53 }],
          [3, 13, 23, 330, 430, 530],
        ),
      );
    },
  );

  it("dataset metadata supplied by a joining tab cannot activate an unversioned cache or a watermark", () => {
    const engine = new Engine();
    const config = engineConfig();
    const live = engine.cache(config);
    engine.put(config.id, batch([3]));
    expect(
      engine.cache({ ...config, version: "joining", finalizedUntil: 3 }),
    ).toEqual(live);
    engine.put(config.id, {
      ...batch([13]),
      meta: { version: "first-response" },
    });
    expect(engine.get(config.id, { start: 3, end: 13 })).toEqual(
      result([3, 13], [{ start: 3, end: 13 }], []),
    );
  });

  it.each([
    { interval: 0 },
    { fields: {} },
    { version: "" },
    { finalizedUntil: Number.NaN },
    {
      interval: 2,
      alignmentOffset: 0,
      finalizedUntil: Number.MAX_SAFE_INTEGER,
    },
  ] satisfies Partial<CacheConfig>[])(
    "invalid config %j creates nothing and cannot disturb an existing cache",
    (change) => {
      const engine = new Engine();
      const config = engineConfig();
      const live = engine.cache(config);
      engine.put(config.id, batch([3, 13]));
      const before = engine.get(config.id, { start: 3, end: 23 });
      const events: EngineEvents["cacheCleared"][] = [];
      engine.on("cacheCleared", (event) => events.push(event));
      expect(() =>
        engine.cache({ ...config, ...change, id: "invalid" }),
      ).toThrow(ConfigError);
      expect(() => engine.get("invalid", { start: 0, end: 0 })).toThrow(
        UnknownCacheError,
      );
      expect(() => engine.cache({ ...config, ...change })).toThrow(ConfigError);
      expect(engine.cache(config)).toEqual(live);
      expect(engine.get(config.id, { start: 3, end: 23 })).toEqual(before);
      engine.clearAll();
      expect(events).toEqual([{ cacheId: config.id, reason: "clear-all" }]);
    },
  );

  it("has stays true after joining, invalidating, clearing and clearAll", () => {
    const engine = new Engine();
    const config = engineConfig();
    engine.cache(config);
    engine.cache(config);
    engine.put(config.id, batch([3]));
    engine.invalidate(config.id, { start: 3, end: 3 });
    expect(engine.has(config.id)).toBe(true);
    engine.clear(config.id);
    expect(engine.has(config.id)).toBe(true);
    engine.clearAll();
    expect(engine.has(config.id)).toBe(true);
  });

  // has(unknownId) is intentionally unpinned pending clarification: §4.6's
  // blanket UnknownCacheError rule includes has, but its boolean signature
  // also admits the ordinary existence-check interpretation.
});
