import { describe, expect, it } from "vitest";
import { InvalidRangeError } from "../src/errors";
import { batch, cache, observe, result } from "./cache-test-helpers";

describe("CacheState watermark — architecture §2.4, §4.5, N16, N17, starter §3.3", () => {
  it.each([
    { watermark: 23, coveredEnd: 13, missStart: 23 },
    { watermark: 23.25, coveredEnd: 23, missStart: 33 },
  ])(
    "excludes t >= $watermark when recording coverage but returns those points",
    ({ watermark, coveredEnd, missStart }) => {
      for (const ranged of [false, true]) {
        const c = cache({ finalizedUntil: watermark });
        c.put(
          batch([3, 13, 23, 33]),
          ranged ? { range: { start: 3, end: 43 } } : {},
        );
        expect(c.get({ start: 3, end: 33 })).toEqual(
          result(
            [3, 13, 23, 33],
            [{ start: 3, end: coveredEnd }],
            [{ start: missStart, end: 33 }],
          ),
        );
      }
    },
  );

  it.each([
    { watermark: -7, coveredEnd: -17, missStart: -7 },
    { watermark: -6.75, coveredEnd: -7, missStart: 3 },
  ])(
    "uses ceil on a negative offset watermark $watermark",
    ({ watermark, coveredEnd, missStart }) => {
      const c = cache({ finalizedUntil: watermark });
      c.put(batch([-17, -7, 3, 13]));
      expect(c.get({ start: -17, end: 13 })).toEqual(
        result(
          [-17, -7, 3, 13],
          [{ start: -17, end: coveredEnd }],
          [{ start: missStart, end: 13 }],
        ),
      );
    },
  );

  it("records nothing for an entirely volatile claim, including empty ranged claims", () => {
    for (const ranged of [false, true]) {
      const c = cache({ finalizedUntil: 23 });
      c.put(batch([23, 43]), ranged ? { range: { start: 23, end: 53 } } : {});
      expect(c.get({ start: 23, end: 53 })).toEqual(
        result([23, 43], [], [{ start: 23, end: 53 }]),
      );
      c.put(batch([]), { range: { start: 33, end: 53 } });
      expect(c.get({ start: 23, end: 53 })).toEqual(
        result([23], [], [{ start: 23, end: 53 }]),
      );
    }
  });

  it("advancing the watermark does not promote provisional slots; a later put covers them", () => {
    const c = cache({ finalizedUntil: 23 });
    c.put(batch([3, 13, 23, 33, 43]), { range: { start: 3, end: 53 } });
    c.setFinalizedUntil(43);
    expect(c.finalizedUntil).toBe(43);
    expect(c.get({ start: 3, end: 53 })).toEqual(
      result(
        [3, 13, 23, 33, 43],
        [{ start: 3, end: 13 }],
        [{ start: 23, end: 53 }],
      ),
    );
    c.put(batch([23, 33], [230, 330]));
    expect(c.get({ start: 3, end: 53 })).toEqual(
      result(
        [3, 13, 23, 33, 43],
        [{ start: 3, end: 33 }],
        [{ start: 43, end: 53 }],
        [3, 13, 230, 330, 43],
      ),
    );
  });

  it("moving backwards subtracts coverage from the new volatile slot onward and keeps points", () => {
    const c = cache({ finalizedUntil: 53 });
    c.put(batch([-17, -7, 3, 13, 23, 33, 43, 53]), {
      range: { start: -27, end: 63 },
    });
    c.setFinalizedUntil(23);
    expect(c.finalizedUntil).toBe(23);
    expect(c.get({ start: -27, end: 63 })).toEqual(
      result(
        [-17, -7, 3, 13, 23, 33, 43, 53],
        [{ start: -27, end: 13 }],
        [{ start: 23, end: 63 }],
      ),
    );
    c.setFinalizedUntil(-6.75);
    expect(c.get({ start: -27, end: 63 })).toEqual(
      result(
        [-17, -7, 3, 13, 23, 33, 43, 53],
        [{ start: -27, end: -7 }],
        [{ start: 3, end: 63 }],
      ),
    );
  });

  it("setting the first watermark withdraws previously authoritative tail coverage", () => {
    const c = cache();
    c.put(batch([3, 13, 23, 33]));
    c.setFinalizedUntil(23);
    expect(c.get({ start: 3, end: 33 })).toEqual(
      result(
        [3, 13, 23, 33],
        [{ start: 3, end: 13 }],
        [{ start: 23, end: 33 }],
      ),
    );
  });

  it("meta establishes a watermark before the current put records coverage", () => {
    const c = cache();
    c.put({ ...batch([3, 13, 23, 33]), meta: { finalizedUntil: 23 } });
    expect(c.finalizedUntil).toBe(23);
    expect(c.get({ start: 3, end: 33 })).toEqual(
      result(
        [3, 13, 23, 33],
        [{ start: 3, end: 13 }],
        [{ start: 23, end: 33 }],
      ),
    );
  });

  it("advancing meta leaves old provisional slots uncovered except within the current claim", () => {
    const c = cache({ finalizedUntil: 23 });
    c.put(batch([3, 13, 23, 33, 43]));
    c.put({ ...batch([33, 43], [330, 430]), meta: { finalizedUntil: 43 } });
    expect(c.finalizedUntil).toBe(43);
    expect(c.get({ start: 3, end: 43 })).toEqual(
      result(
        [3, 13, 23, 33, 43],
        [
          { start: 3, end: 13 },
          { start: 33, end: 33 },
        ],
        [
          { start: 23, end: 23 },
          { start: 43, end: 43 },
        ],
        [3, 13, 23, 330, 430],
      ),
    );
  });

  it.each([13, 43])(
    "ignores lower or equal meta.finalizedUntil=%i while still applying the put",
    (watermark) => {
      const c = cache({ finalizedUntil: 43 });
      c.put(batch([3, 13, 23, 33, 43]));
      c.put({
        ...batch([33, 43, 53], [330, 430, 530]),
        meta: { finalizedUntil: watermark },
      });
      expect(c.finalizedUntil).toBe(43);
      expect(c.get({ start: 3, end: 53 })).toEqual(
        result(
          [3, 13, 23, 33, 43, 53],
          [{ start: 3, end: 33 }],
          [{ start: 43, end: 53 }],
          [3, 13, 23, 330, 430, 530],
        ),
      );
    },
  );

  it("an empty batch can advance metadata without covering the old provisional points", () => {
    const c = cache({ finalizedUntil: 13 });
    c.put(batch([3, 13, 23]));
    c.put({ ...batch([]), meta: { finalizedUntil: 33 } });
    expect(c.finalizedUntil).toBe(33);
    expect(c.get({ start: 3, end: 23 })).toEqual(
      result([3, 13, 23], [{ start: 3, end: 3 }], [{ start: 13, end: 23 }]),
    );
  });

  it.each([
    Number.NaN,
    Infinity,
    -Infinity,
    2 ** 53,
    -(2 ** 53),
    Number.MAX_SAFE_INTEGER,
    "23",
    null,
  ])(
    "invalid direct watermark %j throws without changing anything",
    (watermark) => {
      const c = cache({ version: "v1", finalizedUntil: 33 });
      c.put(batch([-7, 3, 13, 23, 33]));
      const before = observe(c);
      expect(() => c.setFinalizedUntil(watermark as number)).toThrow(
        InvalidRangeError,
      );
      expect(observe(c)).toEqual(before);
    },
  );
});
