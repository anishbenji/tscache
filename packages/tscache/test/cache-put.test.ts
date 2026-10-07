import { describe, expect, expectTypeOf, it } from "vitest";
import { type CachePutResult, CacheState } from "../src/engine/cache";
import { resolveCacheConfig } from "../src/engine/validate";
import type { ResolvedCacheConfig } from "../src/types";
import { batch, cache, result } from "./cache-test-helpers";

describe("CacheState put and config — architecture §2.2–§2.4, §4.5, N3, N11, N13", () => {
  it("exposes resolved config and readonly dataset fields with their initial values", () => {
    const config = resolveCacheConfig({
      id: "configured",
      interval: 10,
      alignmentOffset: 13,
      fields: { price: "f64", volume: "i16" },
      version: "initial",
      finalizedUntil: 23,
    });
    const c = new CacheState(config);
    expect(c.config).toEqual({
      id: "configured",
      interval: 10,
      alignmentOffset: 3,
      fields: { price: "f64", volume: "i16" },
      gapSplitK: 4,
      segmentSlotCap: 32_768,
      warnOnOverlapDiff: false,
      version: "initial",
      finalizedUntil: 23,
    });
    expect(c.version).toBe("initial");
    expect(c.finalizedUntil).toBe(23);
    expectTypeOf<
      Pick<CacheState, "config" | "version" | "finalizedUntil">
    >().toEqualTypeOf<{
      readonly config: ResolvedCacheConfig;
      readonly version: string | undefined;
      readonly finalizedUntil: number | undefined;
    }>();
    const unconfigured = cache();
    expect(unconfigured.version).toBeUndefined();
    expect(unconfigured.finalizedUntil).toBeUndefined();
  });

  it("records only the batch span without a range, including gaps between its points", () => {
    const c = cache();
    const put: CachePutResult = c.put(batch([13, 33]));
    expect(put).toEqual({ warnings: [], cleared: false });
    expect(c.get({ start: 3, end: 43 })).toEqual(
      result(
        [13, 33],
        [{ start: 13, end: 33 }],
        [
          { start: 3, end: 3 },
          { start: 43, end: 43 },
        ],
      ),
    );
  });

  it("without range adds or overwrites sparse points and preserves intervening old points", () => {
    const c = cache();
    c.put(batch([3, 13, 23, 33, 43]));
    c.put(batch([13, 33], [101, 303]));
    expect(c.get({ start: 3, end: 43 })).toEqual(
      result(
        [3, 13, 23, 33, 43],
        [{ start: 3, end: 43 }],
        [],
        [3, 101, 23, 303, 43],
      ),
    );
  });

  it("snaps explicit authority inward and confirms empty flanks without claiming neighbors", () => {
    const c = cache();
    c.put(batch([13, 33]), { range: { start: 4, end: 52 } });
    expect(c.get({ start: 3, end: 53 })).toEqual(
      result(
        [13, 33],
        [{ start: 13, end: 43 }],
        [
          { start: 3, end: 3 },
          { start: 53, end: 53 },
        ],
      ),
    );
    expect(c.get({ start: 43, end: 43 })).toEqual(
      result([], [{ start: 43, end: 43 }], []),
    );
  });

  it("explicit range removes omitted points inside the inward snap and keeps points outside", () => {
    const c = cache();
    c.put(batch([-7, 3, 13, 23, 33, 43, 53]));
    c.put(batch([23], [230]), { range: { start: 4, end: 42 } });
    expect(c.get({ start: -7, end: 53 })).toEqual(
      result(
        [-7, 3, 23, 43, 53],
        [{ start: -7, end: 53 }],
        [],
        [-7, 3, 230, 43, 53],
      ),
    );
  });

  it("empty ranged put replaces with a confirmed gap, even outside the old batch span", () => {
    const c = cache();
    c.put(batch([13, 23]));
    c.put(batch([]), { range: { start: 2, end: 34 } });
    expect(c.get({ start: -7, end: 43 })).toEqual(
      result(
        [],
        [{ start: 3, end: 33 }],
        [
          { start: -7, end: -7 },
          { start: 43, end: 43 },
        ],
      ),
    );
  });

  it("empty unranged put and a range holding no grid point change neither data nor coverage", () => {
    const c = cache();
    c.put(batch([3, 23]));
    const before = c.get({ start: -7, end: 33 });
    expect(c.put(batch([]))).toEqual({ warnings: [], cleared: false });
    expect(c.get({ start: -7, end: 33 })).toEqual(before);
    expect(c.put(batch([]), { range: { start: 4, end: 12 } })).toEqual({
      warnings: [],
      cleared: false,
    });
    expect(c.get({ start: -7, end: 33 })).toEqual(before);
  });

  it("accepts typed-array batches and returns schema dtypes with NaN presence preserved", () => {
    const c = cache();
    c.put({
      timestamps: new Float64Array([-7, 3]),
      fields: {
        price: new Float32Array([Number.NaN, 1.5]),
        volume: new Float64Array([1.9, -2.9]),
      },
    });
    expect(c.get({ start: -7, end: 3 })).toEqual(
      result([-7, 3], [{ start: -7, end: 3 }], [], [Number.NaN, 1.5], [1, -2]),
    );
  });
});
