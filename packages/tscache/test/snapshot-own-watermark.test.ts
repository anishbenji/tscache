import { describe, expect, it, vi } from "vitest";
import { CacheState } from "../src/engine/cache";
import { Engine } from "../src/engine/engine";
import { resolveCacheConfig } from "../src/engine/validate";
import type { Range, Snapshot } from "../src/types";
import { batch, engineConfig } from "./engine-test-helpers";
import {
  fixture,
  requireCache,
  requirePage,
  state,
} from "./persist-test-helpers";
import { snapshotPayload, thrown } from "./snapshot-test-helpers";

function envelope(offset = 0): Snapshot {
  return {
    format: 1,
    interval: 10,
    alignmentOffset: offset,
    fields: { price: "f64", volume: "i16" },
    range: { start: offset, end: offset + 60 },
    version: "seed",
    segments: [],
    coverage: [],
  };
}

describe.each(["CacheState.hydrate", "Engine.hydrate"] as const)(
  "%s own watermark — architecture §2.8, §4.5, N69",
  (seam) => {
    function target(offset = 0, populated = false) {
      const cfg = engineConfig({
        alignmentOffset: offset,
        ...(populated ? { version: "live", finalizedUntil: offset + 20 } : {}),
      });
      const onVersionClear = vi.fn();
      const cache = new CacheState(resolveCacheConfig(cfg), { onVersionClear });
      const engine = new Engine();
      engine.cache(cfg);
      engine.on("cacheCleared", onVersionClear);
      if (populated) {
        cache.put(batch([offset, offset + 10, offset + 30], [7, 8, 9]));
        engine.put(
          cfg.id,
          batch([offset, offset + 10, offset + 30], [7, 8, 9]),
        );
      }
      const range = { start: offset, end: offset + 60 };
      return {
        hydrate: (s: Snapshot) =>
          seam === "CacheState.hydrate"
            ? cache.hydrate(s)
            : engine.hydrate(cfg.id, s),
        snapshot: () =>
          seam === "CacheState.hydrate"
            ? cache.snapshot(range)
            : engine.snapshot(cfg.id, range),
        get: () =>
          seam === "CacheState.hydrate"
            ? cache.get(range)
            : engine.get(cfg.id, range),
        onVersionClear,
      };
    }

    it.each([
      { offset: 0, watermark: 30, lastFinal: 20 },
      { offset: 0, watermark: 30.25, lastFinal: 30 },
      { offset: 3, watermark: 33, lastFinal: 23 },
      { offset: 3, watermark: 33.25, lastFinal: 33 },
    ])(
      "accepts the final slot below $watermark on offset $offset",
      ({ offset, watermark, lastFinal }) => {
        const t = target(offset);
        const coverage = [{ start: offset, end: lastFinal }];
        expect(
          t.hydrate({
            ...envelope(offset),
            finalizedUntil: watermark,
            coverage,
          }),
        ).toEqual({ applied: coverage });
        expect(t.snapshot()).toMatchObject({
          coverage,
          version: "seed",
          finalizedUntil: watermark,
        });
      },
    );

    it.each([
      { offset: 0, watermark: 30, end: 30 },
      { offset: 0, watermark: 30, end: 40 },
      { offset: 0, watermark: 30.25, end: 40 },
      { offset: 3, watermark: 33, end: 33 },
      { offset: 3, watermark: 33.25, end: 43 },
      { offset: 3, watermark: 33.25, end: 53 },
    ])(
      "rejects coverage ending at $end against $watermark on offset $offset, atomically",
      ({ offset, watermark, end }) => {
        // Test an unversioned receiver too: neither an empty seed nor a stale seed may be repaired.
        for (const populated of [false, true]) {
          const t = target(offset, populated);
          const before = t.snapshot();
          const error = thrown(() =>
            t.hydrate({
              ...envelope(offset),
              finalizedUntil: watermark,
              coverage: [{ start: offset, end }],
            }),
          );
          expect(error.message).toMatch(/^invalid snapshot:/);
          expect(error.message).toContain("coverage[0]");
          expect(error.message).toContain(String(watermark));
          expect(t.snapshot()).toEqual(before);
          expect(t.onVersionClear).not.toHaveBeenCalled();
        }
      },
    );

    it("rejects coverage[1] before applying the first valid range or adopting metadata", () => {
      const t = target();
      const before = t.snapshot();
      const error = thrown(() =>
        t.hydrate({
          ...envelope(),
          finalizedUntil: 30,
          coverage: [
            { start: 0, end: 0 },
            { start: 20, end: 30 },
          ],
        }),
      );
      expect(error.message).toMatch(/^invalid snapshot:/);
      expect(error.message).toContain("coverage[1]");
      expect(error.message).toContain("30");
      expect(t.snapshot()).toEqual(before);
    });

    it("validates the own watermark before returning version-mismatch", () => {
      const t = target(0, true);
      const before = t.snapshot();
      const error = thrown(() =>
        t.hydrate({
          ...envelope(),
          version: "older",
          finalizedUntil: 30,
          coverage: [{ start: 0, end: 30 }],
        }),
      );
      expect(error.message).toMatch(/^invalid snapshot:/);
      expect(error.message).toContain("coverage[0]");
      expect(t.snapshot()).toEqual(before);
      expect(t.onVersionClear).not.toHaveBeenCalled();
    });

    it("accepts points at and beyond its watermark outside coverage, without applying them", () => {
      for (const finalizedUntil of [33, 43]) {
        const t = target(3);
        const coverage = [{ start: 3, end: 23 }];
        expect(
          t.hydrate({
            ...envelope(3),
            finalizedUntil,
            coverage,
            segments: [snapshotPayload()],
          }),
        ).toEqual({ applied: coverage });
        expect(t.get()).toMatchObject({
          timestamps: new Float64Array([3, 23]),
          fields: {
            price: new Float64Array([10, Number.NaN]),
            volume: new Int16Array([1, 2]),
          },
          coverage,
        });
        expect(t.snapshot().finalizedUntil).toBe(finalizedUntil);
      }
    });

    it("does not impose an own bound without finalizedUntil", () => {
      const t = target();
      const coverage = [{ start: 0, end: 60 }];
      expect(t.hydrate({ ...envelope(), coverage })).toEqual({
        applied: coverage,
      });
      expect(t.snapshot()).not.toHaveProperty("finalizedUntil");
      expect(t.get().coverage).toEqual(coverage);
    });

    it("keeps earlier coverage malformation ahead of the new bound and payload checks", () => {
      const t = target();
      const before = t.snapshot();
      const malformed = {
        ...envelope(),
        coverage: [{ start: 0, end: 31 }],
      };
      const earlier = thrown(() => t.hydrate(malformed));
      const combined = thrown(() =>
        t.hydrate({
          ...malformed,
          finalizedUntil: 30,
          segments: [{ ...snapshotPayload(), format: 2 }],
        } as unknown as Snapshot),
      );
      expect(combined.message).toBe(earlier.message);
      expect(t.snapshot()).toEqual(before);
    });

    it("checks the own bound before decoding a malformed payload", () => {
      const t = target();
      const invalid = {
        ...envelope(),
        finalizedUntil: 30,
        coverage: [{ start: 0, end: 30 }],
      };
      const isolated = thrown(() => t.hydrate(invalid));
      const combined = thrown(() =>
        t.hydrate({
          ...invalid,
          segments: [{ ...snapshotPayload(), format: 2 }],
        } as unknown as Snapshot),
      );
      expect(combined.message).toBe(isolated.message);
      expect(combined.message).toMatch(/^invalid snapshot:/);
    });
  },
);

describe("taken snapshots stay valid — architecture §4.5 property (a), N69", () => {
  it.each([
    "empty",
    "gaps",
    "unbounded",
    "aligned",
    "unaligned",
    "backwards",
    "forwards",
    "invalidated",
  ] as const)(
    "round trips Engine.snapshot and snapshot-enabled get from %s state",
    (kind) => {
      const engine = new Engine();
      engine.cache(engineConfig({ id: "source", version: "v1" }));
      const range: Range = { start: -7, end: 73 };
      if (kind !== "empty") {
        if (kind !== "unbounded")
          engine.setFinalizedUntil("source", kind === "unaligned" ? 33.25 : 33);
        engine.put(
          "source",
          batch(kind === "gaps" ? [] : [-7, 3, 23, 33, 43, 73]),
          { range },
        );
        if (kind === "backwards") engine.setFinalizedUntil("source", 13);
        if (kind === "forwards") engine.setFinalizedUntil("source", 63);
        if (kind === "invalidated")
          engine.invalidate("source", { start: 3, end: 13 });
      }
      const read = engine.get("source", range, { snapshot: true });
      const snapshot = engine.snapshot("source", range);
      expect(read.snapshot).toEqual(snapshot);
      for (const seed of [snapshot, read.snapshot]) {
        if (!seed) throw new Error("Expected requested snapshot");
        const cache = new CacheState(resolveCacheConfig(engineConfig()));
        expect(cache.hydrate(seed)).toEqual({ applied: read.coverage });
        expect(cache.get(range).coverage).toEqual(read.coverage);
        const indices = Array.from(read.timestamps.keys()).filter((i) =>
          read.coverage.some(
            (r) =>
              (read.timestamps[i] as number) >= r.start &&
              (read.timestamps[i] as number) <= r.end,
          ),
        );
        expect(Array.from(cache.get(range).timestamps)).toEqual(
          indices.map((i) => read.timestamps[i]),
        );
        for (const name of ["price", "volume"])
          expect(Array.from(cache.get(range).fields[name] ?? [])).toEqual(
            indices.map((i) => read.fields[name]?.[i]),
          );
        expect(cache.version).toBe(snapshot.version);
        expect(cache.finalizedUntil).toBe(snapshot.finalizedUntil);
        engine.cache(
          engineConfig({
            id: `target-${seed === snapshot ? "snapshot" : "get"}`,
          }),
        );
        expect(
          engine.hydrate(
            `target-${seed === snapshot ? "snapshot" : "get"}`,
            seed,
          ),
        ).toEqual({ applied: read.coverage });
      }
    },
  );
});

describe("restore remains distinct — architecture §4.10.5 steps 5–6", () => {
  it("skips a page carrying finalizedUntil, keeps the cache record watermark, and requests rewrite", () => {
    const stored = fixture({}, [0]);
    requireCache(stored).finalizedUntil = 100;
    const invalidPage = requirePage(fixture({}, [150]));
    invalidPage.snapshot.finalizedUntil = 200;
    const cache = state();
    expect(
      cache.restore({ ...stored, pages: [...stored.pages, invalidPage] }),
    ).toEqual({
      applied: [{ start: 0, end: 0 }],
      rewrite: true,
    });
    expect(cache.get({ start: 0, end: 150 }).timestamps).toEqual(
      new Float64Array([0]),
    );
    expect(cache.coverage({ start: 150, end: 150 })).toEqual([]);
    expect(cache.finalizedUntil).toBe(100);
  });

  it("still clips a valid page by the cache record watermark instead of rejecting it whole", () => {
    const stored = fixture({}, [0, 3]);
    requireCache(stored).finalizedUntil = 2;
    const cache = state();
    expect(cache.restore(stored)).toEqual({
      applied: [{ start: 0, end: 1 }],
      rewrite: true,
    });
    expect(cache.get({ start: 0, end: 3 }).timestamps).toEqual(
      new Float64Array([0]),
    );
    expect(cache.finalizedUntil).toBe(2);
  });
});
