import { describe, expect, it } from "vitest";
import type { CachePutResult } from "../src/engine/cache";
import { batch, cache, result } from "./cache-test-helpers";

describe("CacheState warnings — architecture §2.2, §2.4, §4.3, §4.5, starter §3.3", () => {
  it("returns overlap warnings in milliseconds on an offset grid across negative and positive slots", () => {
    const c = cache({ warnOnOverlapDiff: true });
    c.put(batch([-17, 3, 33], [1, 2, 3], [10, 20, 30]));
    const put: CachePutResult = c.put(
      batch([-17, 3, 33], [11, 22, 33], [100, 200, 300]),
    );
    expect(put).toEqual({
      warnings: [
        { range: { start: -17, end: 33 }, fields: ["price", "volume"] },
      ],
      cleared: false,
    });
  });

  it.each([
    { watermark: 23, end: 13 },
    { watermark: 23.25, end: 23 },
  ])(
    "clips a straddling warning at volatileFrom - 1 for watermark $watermark",
    ({ watermark, end }) => {
      const c = cache({ warnOnOverlapDiff: true, finalizedUntil: watermark });
      c.put(batch([3, 13, 23, 33]));
      expect(c.put(batch([3, 13, 23, 33], [30, 130, 230, 330]))).toEqual({
        warnings: [{ range: { start: 3, end }, fields: ["price"] }],
        cleared: false,
      });
      expect(c.get({ start: 3, end: 33 })).toEqual(
        result(
          [3, 13, 23, 33],
          [{ start: 3, end }],
          [{ start: end + 10, end: 33 }],
          [30, 130, 230, 330],
        ),
      );
    },
  );

  it("clips a warning across a sparse gap at the last finalized slot even without a point there", () => {
    const c = cache({ warnOnOverlapDiff: true, finalizedUntil: 23 });
    c.put(batch([3, 33]));
    expect(c.put(batch([3, 33], [30, 330])).warnings).toEqual([
      { range: { start: 3, end: 13 }, fields: ["price"] },
    ]);
  });

  it("drops wholly volatile warnings while the new provisional values still win", () => {
    const c = cache({ warnOnOverlapDiff: true, finalizedUntil: 23 });
    c.put(batch([23, 33]));
    expect(c.put(batch([23, 33], [230, 330]))).toEqual({
      warnings: [],
      cleared: false,
    });
    expect(c.get({ start: 23, end: 33 })).toEqual(
      result([23, 33], [], [{ start: 23, end: 33 }], [230, 330]),
    );
  });

  it.each([false, undefined])(
    "returns no warning with warnOnOverlapDiff=%j",
    (enabled) => {
      const c = cache(
        enabled === undefined ? {} : { warnOnOverlapDiff: enabled },
      );
      c.put(batch([3, 13]));
      expect(c.put(batch([3, 13], [30, 130]))).toEqual({
        warnings: [],
        cleared: false,
      });
      expect(c.get({ start: 3, end: 13 })).toEqual(
        result([3, 13], [{ start: 3, end: 13 }], [], [30, 130]),
      );
    },
  );

  it("still warns for changed nonvolatile points after their coverage was invalidated", () => {
    const c = cache({ warnOnOverlapDiff: true });
    c.put(batch([3, 13]));
    c.invalidate({ start: 3, end: 13 });
    expect(c.put(batch([3, 13], [30, 130])).warnings).toEqual([
      { range: { start: 3, end: 13 }, fields: ["price"] },
    ]);
  });

  it("replacement removes absent points without warning for deletions", () => {
    const c = cache({ warnOnOverlapDiff: true });
    c.put(batch([3, 13, 23, 33]));
    expect(
      c.put(batch([13], [130]), { range: { start: 3, end: 33 } }).warnings,
    ).toEqual([{ range: { start: 13, end: 13 }, fields: ["price"] }]);
    expect(c.put(batch([]), { range: { start: 3, end: 33 } }).warnings).toEqual(
      [],
    );
  });

  it("a version mismatch compares against the cleared dataset, producing no old-data warning", () => {
    const c = cache({ version: "v1", warnOnOverlapDiff: true });
    c.put(batch([3], [1]));
    expect(c.put({ ...batch([3], [2]), meta: { version: "v2" } })).toEqual({
      warnings: [],
      cleared: true,
    });
  });
});
