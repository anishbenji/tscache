import { describe, expect, it } from "vitest";
import { Engine } from "../src/engine/engine";
import { resolveCacheConfig } from "../src/engine/validate";
import { ConfigError } from "../src/errors";
import { all, batch, config, type PersistConfig } from "./persist-test-helpers";

describe("persist config (§4.10.1, N20, N45)", () => {
  it("defaults to false and Engine.cache returns the resolved flag", () => {
    const { persist: _ignored, ...input } = config();
    expect(resolveCacheConfig(input)).toHaveProperty("persist", false);
    expect(new Engine().cache(input)).toHaveProperty("persist", false);
  });
  it.each([true, false])("resolves explicit %s", (persist) => {
    expect(resolveCacheConfig(config({ persist }))).toHaveProperty(
      "persist",
      persist,
    );
    expect(new Engine().cache(config({ persist }))).toHaveProperty(
      "persist",
      persist,
    );
  });
  it.each([null, 0, 1, "true", {}, []].map((persist) => ({ persist })))(
    "rejects non-boolean $persist before creating a cache",
    ({ persist }) => {
      const engine = new Engine();
      const input = { ...config(), persist } as PersistConfig;
      expect(() => resolveCacheConfig(input)).toThrow(ConfigError);
      expect(() => engine.cache(input)).toThrow(/persist must be a boolean/);
      expect(engine.has(input.id)).toBe(false);
    },
  );
  it.each([true, false])(
    "joining cannot change structural persist=%s",
    (persist) => {
      const engine = new Engine();
      const original = engine.cache(config({ persist }));
      engine.put("persist", batch([0], [42]));
      const before = engine.snapshot("persist", all);
      expect(() => engine.cache(config({ persist: !persist }))).toThrow(
        ConfigError,
      );
      expect(() => engine.cache(config({ persist: !persist }))).toThrow(
        /persist/,
      );
      expect(engine.cache(config({ persist }))).toEqual(original);
      expect(engine.snapshot("persist", all)).toEqual(before);
    },
  );
});
