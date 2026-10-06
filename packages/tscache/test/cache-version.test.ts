import { describe, expect, it } from "vitest";
import type { CachePutResult } from "../src/engine/cache";
import type { PutBatch } from "../src/types";
import {
  batch,
  cache,
  expectPutError,
  observe,
  result,
} from "./cache-test-helpers";

describe("CacheState version — architecture §2.4, §2.6, §4.5, N17, N18, starter §3.3", () => {
  it("a mismatching version clears data and coverage before applying the put and adopts the new version", () => {
    const c = cache({ version: "v1", finalizedUntil: 33 });
    c.put(batch([-7, 3, 13]));
    const config = structuredClone(c.config);
    const put: CachePutResult = c.put({
      ...batch([23, 33]),
      meta: { version: "v2", finalizedUntil: 43 },
    });
    expect(put).toEqual({ warnings: [], cleared: true });
    expect(c.version).toBe("v2");
    expect(c.finalizedUntil).toBe(43);
    expect(c.config).toEqual(config);
    expect(c.get({ start: -7, end: 43 })).toEqual(
      result(
        [23, 33],
        [{ start: 23, end: 33 }],
        [
          { start: -7, end: 13 },
          { start: 43, end: 43 },
        ],
      ),
    );
  });

  it("a mismatch keeps the dataset watermark and ignores a lower meta watermark", () => {
    const c = cache({ version: "v1", finalizedUntil: 23 });
    c.put(batch([-7, 3]));
    expect(
      c.put({
        ...batch([13, 23, 33]),
        meta: { version: "v2", finalizedUntil: 13 },
      }).cleared,
    ).toBe(true);
    expect(c.finalizedUntil).toBe(23);
    // N19 (decided after this test was written): the response called
    // t >= 13 provisional, so it covers nothing, not even slot 13.
    expect(c.get({ start: -7, end: 33 })).toEqual(
      result([13, 23, 33], [], [{ start: -7, end: 33 }]),
    );
  });

  it("equal meta.version merges without clearing", () => {
    const c = cache({ version: "v1" });
    c.put(batch([3, 13]));
    expect(c.put({ ...batch([23]), meta: { version: "v1" } })).toEqual({
      warnings: [],
      cleared: false,
    });
    expect(c.version).toBe("v1");
    expect(c.get({ start: 3, end: 23 })).toEqual(
      result([3, 13, 23], [{ start: 3, end: 23 }], []),
    );
  });

  it("absent meta.version never clears a versioned cache, with or without other metadata", () => {
    const c = cache({ version: "v1" });
    c.put(batch([3]));
    expect(c.put(batch([13])).cleared).toBe(false);
    expect(
      c.put({ ...batch([23]), meta: { finalizedUntil: 33 } }).cleared,
    ).toBe(false);
    expect(c.version).toBe("v1");
    expect(c.get({ start: 3, end: 23 })).toEqual(
      result([3, 13, 23], [{ start: 3, end: 23 }], []),
    );
  });

  it("an unversioned cache adopts the first version without clearing; a later mismatch clears", () => {
    const c = cache();
    c.put(batch([-7, 3]));
    expect(c.version).toBeUndefined();
    expect(c.put({ ...batch([13]), meta: { version: "v1" } }).cleared).toBe(
      false,
    );
    expect(c.version).toBe("v1");
    expect(c.get({ start: -7, end: 13 })).toEqual(
      result([-7, 3, 13], [{ start: -7, end: 13 }], []),
    );
    expect(c.put({ ...batch([23]), meta: { version: "v2" } })).toEqual({
      warnings: [],
      cleared: true,
    });
    expect(c.version).toBe("v2");
    expect(c.get({ start: -7, end: 23 })).toEqual(
      result([23], [{ start: 23, end: 23 }], [{ start: -7, end: 13 }]),
    );
  });

  it("a mismatch on an empty batch still clears and leaves the cache usable", () => {
    const c = cache({ version: "v1" });
    c.put(batch([3, 13]));
    expect(c.put({ ...batch([]), meta: { version: "v2" } })).toEqual({
      warnings: [],
      cleared: true,
    });
    expect(c.get({ start: 3, end: 23 })).toEqual(
      result([], [], [{ start: 3, end: 23 }]),
    );
    expect(c.put(batch([23])).cleared).toBe(false);
    expect(c.version).toBe("v2");
    expect(c.get({ start: 23, end: 23 })).toEqual(
      result([23], [{ start: 23, end: 23 }], []),
    );
  });

  it.each([
    { version: "", finalizedUntil: 53 },
    ...[42, null, true, {}, Symbol("version")].map((version) => ({
      version,
      finalizedUntil: 53,
    })),
    ...[Number.NaN, Infinity, -Infinity, "53", null, true].map(
      (finalizedUntil) => ({
        version: "v2",
        finalizedUntil,
      }),
    ),
  ])(
    "invalid metadata %j rejects before clearing, merging or advancing",
    (meta) => {
      for (const versioned of [false, true]) {
        for (const empty of [false, true]) {
          const c = cache({
            finalizedUntil: 33,
            ...(versioned ? { version: "v1" } : {}),
          });
          c.put(batch([-7, 3, 13, 23, 33]));
          const before = observe(c);
          const input = {
            ...batch(empty ? [] : [13, 43], empty ? [] : [999, 999]),
            meta,
          } as PutBatch;
          expectPutError(
            () => c.put(input, { range: { start: -7, end: 53 } }),
            "field-mismatch",
            -1,
          );
          expect(observe(c)).toEqual(before);
        }
      }
    },
  );
});
