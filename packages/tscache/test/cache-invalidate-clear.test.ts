import { describe, expect, it } from "vitest";
import { InvalidRangeError } from "../src/errors";
import type { Range } from "../src/types";
import {
  batch,
  cache,
  malformedRanges,
  observe,
  result,
} from "./cache-test-helpers";

describe("CacheState get and invalidate — architecture §2.3, §4.1, §4.4, §4.5, N1, N16", () => {
  it("snaps get outward and returns clipped coverage and uncached misses tiling the request", () => {
    const c = cache();
    c.put(batch([-17, 3, 23, 43]), { range: { start: -17, end: 43 } });
    c.invalidate({ start: -7, end: 13 });
    expect(c.get({ start: -16.5, end: 32.5 })).toEqual(
      result(
        [-17, 3, 23],
        [
          { start: -17, end: -17 },
          { start: 23, end: 33 },
        ],
        [{ start: -7, end: 13 }],
      ),
    );
    expect(c.get({ start: 13.25, end: 13.25 })).toEqual(
      result([23], [{ start: 23, end: 23 }], [{ start: 13, end: 13 }]),
    );
  });

  it("invalidate snaps outward, keeps all points visible and is idempotent", () => {
    const c = cache({ version: "v1", finalizedUntil: 53 });
    c.put(batch([-17, -7, 3, 13, 23, 33, 43]));
    c.invalidate({ start: -6.75, end: 22.75 });
    const expected = result(
      [-17, -7, 3, 13, 23, 33, 43],
      [
        { start: -17, end: -17 },
        { start: 33, end: 43 },
      ],
      [{ start: -7, end: 23 }],
    );
    expect(c.get({ start: -17, end: 43 })).toEqual(expected);
    const before = observe(c);
    c.invalidate({ start: -6.75, end: 22.75 });
    c.invalidate({ start: 103, end: 113 });
    expect(observe(c)).toEqual(before);
    expect(c.version).toBe("v1");
    expect(c.finalizedUntil).toBe(53);
  });

  it("invalidating an aligned singleton forgets just that inclusive slot", () => {
    const c = cache();
    c.put(batch([3, 13, 23]));
    c.invalidate({ start: 13, end: 13 });
    expect(c.get({ start: 3, end: 23 })).toEqual(
      result(
        [3, 13, 23],
        [
          { start: 3, end: 3 },
          { start: 23, end: 23 },
        ],
        [{ start: 13, end: 13 }],
      ),
    );
    c.put(batch([13], [130]));
    expect(c.get({ start: 3, end: 23 })).toEqual(
      result([3, 13, 23], [{ start: 3, end: 23 }], [], [3, 130, 23]),
    );
  });

  it.each([undefined, ...malformedRanges])(
    "malformed get/invalidate range %j throws and changes nothing",
    (range) => {
      const c = cache({ version: "v1", finalizedUntil: 33 });
      c.put(batch([-7, 3, 13, 23, 33]));
      const before = observe(c);
      expect(() => c.get(range as Range)).toThrow(InvalidRangeError);
      expect(observe(c)).toEqual(before);
      expect(() => c.invalidate(range as Range)).toThrow(InvalidRangeError);
      expect(observe(c)).toEqual(before);
    },
  );

  it.each([Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER])(
    "rejects an outward snap beyond the supported ms domain at %i",
    (t) => {
      const c = cache();
      c.put(batch([3, 13]));
      const before = observe(c);
      expect(() => c.get({ start: t, end: t })).toThrow(InvalidRangeError);
      expect(() => c.invalidate({ start: t, end: t })).toThrow(
        InvalidRangeError,
      );
      expect(observe(c)).toEqual(before);
    },
  );

  it.each([Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER])(
    "accepts an aligned singleton at safe boundary %i on a unit grid",
    (t) => {
      const c = cache({ interval: 1, alignmentOffset: 0, segmentSlotCap: 1 });
      c.put(batch([t], [42], [4]));
      expect(c.get({ start: t, end: t })).toEqual(
        result([t], [{ start: t, end: t }], [], [42], [4]),
      );
      c.invalidate({ start: t, end: t });
      expect(c.get({ start: t, end: t })).toEqual(
        result([t], [], [{ start: t, end: t }], [42], [4]),
      );
    },
  );

  it("returned arrays and ranges can be mutated without altering later reads", () => {
    const c = cache({ finalizedUntil: 23 });
    c.put(batch([3, 13, 23]));
    const request = { start: 3, end: 33 };
    const expected = c.get(request);
    const read = c.get(request);
    read.timestamps.fill(999);
    read.fields.price?.fill(999);
    read.fields.volume?.fill(999);
    const covered = read.coverage[0];
    const miss = read.misses[0];
    if (covered === undefined || miss === undefined)
      throw new Error("Missing test ranges");
    covered.start = -197;
    miss.range.end = 203;
    read.coverage.length = 0;
    read.misses.length = 0;
    expect(c.get(request)).toEqual(expected);
  });
});

describe("CacheState clear — architecture §4.5, starter §3.3", () => {
  it("drops data and coverage but keeps original config, current version and current watermark; usable again", () => {
    const c = cache({ version: "v1", finalizedUntil: 23 });
    const config = structuredClone(c.config);
    c.put({
      ...batch([3, 13, 23]),
      meta: { version: "v2", finalizedUntil: 43 },
    });
    c.clear();
    expect(c.config).toEqual(config);
    expect(c.version).toBe("v2");
    expect(c.finalizedUntil).toBe(43);
    expect(c.get({ start: 3, end: 53 })).toEqual(
      result([], [], [{ start: 3, end: 53 }]),
    );
    c.clear();
    expect(c.get({ start: 3, end: 53 })).toEqual(
      result([], [], [{ start: 3, end: 53 }]),
    );
    expect(c.put({ ...batch([13, 33, 43]), meta: { version: "v2" } })).toEqual({
      warnings: [],
      cleared: false,
    });
    expect(c.get({ start: 3, end: 53 })).toEqual(
      result(
        [13, 33, 43],
        [{ start: 13, end: 33 }],
        [
          { start: 3, end: 3 },
          { start: 43, end: 53 },
        ],
      ),
    );
  });

  it("clear of an empty unversioned cache keeps undefined dataset metadata", () => {
    const c = cache();
    const before = observe(c);
    c.clear();
    expect(observe(c)).toEqual(before);
  });
});
