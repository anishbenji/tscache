import { describe, expect, it } from "vitest";
import { CacheState } from "../src/engine/cache";
import { resolveCacheConfig } from "../src/engine/validate";
import { ConfigError } from "../src/errors";
import type { PutBatch } from "../src/types";
import {
  batch,
  cache,
  expectPutError,
  observe,
  result,
} from "./cache-test-helpers";

// Implementer tests (not contract tests): N19 and two rejection paths the
// round 2 review found untested.

describe("CacheState clips a response's authority at its own watermark (N19)", () => {
  it("a late empty ranged response with an older watermark neither deletes nor confirms provisional slots", () => {
    const c = cache({ finalizedUntil: 43 });
    c.put(batch([3, 13, 23, 33, 43, 53]), { range: { start: 3, end: 53 } });
    // The response considered t >= 13 provisional: it may only speak for slot 3.
    c.put(
      { ...batch([]), meta: { finalizedUntil: 13 } },
      { range: { start: 3, end: 53 } },
    );
    expect(c.finalizedUntil).toBe(43);
    expect(c.get({ start: 3, end: 53 })).toEqual(
      result(
        [13, 23, 33, 43, 53],
        [{ start: 3, end: 33 }],
        [{ start: 43, end: 53 }],
      ),
    );
  });

  it("points at or beyond the response's watermark are upserted, not replaced, and not covered", () => {
    const c = cache();
    c.put(batch([3, 13, 23, 33]));
    c.put(
      { ...batch([3, 23, 33], [30, 230, 330]), meta: { finalizedUntil: 23 } },
      { range: { start: 3, end: 43 } },
    );
    expect(c.finalizedUntil).toBe(23);
    // Below 23: replaced (13 removed) and covered. From 23: new values win,
    // nothing removed, nothing covered.
    expect(c.get({ start: 3, end: 43 })).toEqual(
      result(
        [3, 23, 33],
        [{ start: 3, end: 13 }],
        [{ start: 23, end: 43 }],
        [30, 230, 330],
      ),
    );
  });

  it("an unranged put with a watermark covers only its final points", () => {
    const c = cache({ finalizedUntil: 53 });
    c.put({ ...batch([3, 13, 23, 33]), meta: { finalizedUntil: 23 } });
    expect(c.get({ start: 3, end: 33 })).toEqual(
      result(
        [3, 13, 23, 33],
        [{ start: 3, end: 13 }],
        [{ start: 23, end: 33 }],
      ),
    );
  });

  it("a response whose watermark is at or below its range start replaces nothing and covers nothing", () => {
    const c = cache({ finalizedUntil: 53 });
    c.put(batch([3, 13, 23]), { range: { start: 3, end: 23 } });
    c.put(
      { ...batch([13], [130]), meta: { finalizedUntil: 3 } },
      { range: { start: 3, end: 23 } },
    );
    expect(c.get({ start: 3, end: 23 })).toEqual(
      result([3, 13, 23], [{ start: 3, end: 23 }], [], [3, 130, 23]),
    );
  });
});

describe("CacheState rejects whole-metadata and config watermark problems", () => {
  it.each([null, 42, "v2", true])(
    "meta %j is rejected as field-mismatch without changing state",
    (meta) => {
      const c = cache({ version: "v1", finalizedUntil: 33 });
      c.put(batch([3, 13]));
      const before = observe(c);
      expectPutError(
        () => c.put({ ...batch([23]), meta } as unknown as PutBatch),
        "field-mismatch",
        -1,
      );
      expect(observe(c)).toEqual(before);
    },
  );

  it("a config watermark whose next grid point is unsafe is a ConfigError", () => {
    const config = resolveCacheConfig({
      id: "edge",
      interval: 2,
      fields: { x: "f64" },
      finalizedUntil: Number.MAX_SAFE_INTEGER,
    });
    expect(() => new CacheState(config)).toThrow(ConfigError);
    expect(() => new CacheState(config)).toThrow(/finalizedUntil/);
  });
});
