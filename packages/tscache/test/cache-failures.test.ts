import { afterEach, describe, expect, it, vi } from "vitest";
import { SegmentStore } from "../src/engine/merge";
import { batch, cache, result } from "./cache-test-helpers";

// Implementer tests (not contract tests): what a put leaves behind when the
// store cannot allocate (architecture §4.5, order inside put), and warnings
// judged against a watermark the same put advances.

describe("CacheState when the store write fails", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { name: "ranged replacement", options: { range: { start: 3, end: 33 } } },
    { name: "unranged upsert", options: undefined },
  ])(
    "withdraws the claim's coverage, keeps the rest and rethrows: $name",
    ({ options }) => {
      const c = cache({ finalizedUntil: 73, version: "v1" });
      c.put(batch([-17, -7, 3, 13, 23, 33, 43, 53]));
      const failure = new RangeError("Array buffer allocation failed");
      vi.spyOn(SegmentStore.prototype, "put").mockImplementation(() => {
        throw failure;
      });
      expect(() =>
        c.put(
          { ...batch([3, 33], [30, 330]), meta: { finalizedUntil: 93 } },
          options,
        ),
      ).toThrow(failure);
      vi.restoreAllMocks();
      // The claim [3, 33] is no longer authoritative; the flanks still are,
      // and neither the watermark nor the version moved.
      expect(c.finalizedUntil).toBe(73);
      expect(c.version).toBe("v1");
      expect(c.get({ start: -17, end: 53 })).toEqual(
        result(
          [-17, -7, 3, 13, 23, 33, 43, 53],
          [
            { start: -17, end: -7 },
            { start: 43, end: 53 },
          ],
          [{ start: 3, end: 33 }],
        ),
      );
      // The same put succeeds once allocation works again.
      c.put(
        { ...batch([3, 33], [30, 330]), meta: { finalizedUntil: 93 } },
        options,
      );
      expect(c.finalizedUntil).toBe(93);
      expect(c.get({ start: -17, end: 53 })).toEqual(
        result(
          options === undefined
            ? [-17, -7, 3, 13, 23, 33, 43, 53]
            : [-17, -7, 3, 33, 43, 53],
          [{ start: -17, end: 53 }],
          [],
          options === undefined
            ? [-17, -7, 30, 13, 23, 330, 43, 53]
            : [-17, -7, 30, 330, 43, 53],
        ),
      );
    },
  );

  it("a version mismatch that clears and then fails to write leaves an empty, consistent cache", () => {
    const c = cache({ version: "v1" });
    c.put(batch([3, 13]));
    vi.spyOn(SegmentStore.prototype, "put").mockImplementationOnce(() => {
      throw new RangeError("Array buffer allocation failed");
    });
    expect(() => c.put({ ...batch([23]), meta: { version: "v2" } })).toThrow(
      RangeError,
    );
    // Documented order: the clear happened before the write.
    expect(c.version).toBe("v2");
    expect(c.get({ start: 3, end: 23 })).toEqual(
      result([], [], [{ start: 3, end: 23 }]),
    );
  });
});

describe("CacheState warnings against a watermark the same put moves", () => {
  it("judges warnings against the advanced watermark", () => {
    const c = cache({ warnOnOverlapDiff: true, finalizedUntil: 23 });
    c.put(batch([3, 13, 23, 33]));
    expect(
      c.put({
        ...batch([3, 13, 23, 33], [30, 130, 230, 330]),
        meta: { finalizedUntil: 43 },
      }),
    ).toEqual({
      warnings: [{ range: { start: 3, end: 33 }, fields: ["price"] }],
      cleared: false,
    });
    expect(c.finalizedUntil).toBe(43);
  });

  it("an ignored lower meta watermark leaves the filter where it was", () => {
    const c = cache({ warnOnOverlapDiff: true, finalizedUntil: 23 });
    c.put(batch([3, 13, 23, 33]));
    expect(
      c.put({
        ...batch([3, 13, 23, 33], [30, 130, 230, 330]),
        meta: { finalizedUntil: 13 },
      }).warnings,
    ).toEqual([{ range: { start: 3, end: 13 }, fields: ["price"] }]);
    expect(c.finalizedUntil).toBe(23);
  });
});
