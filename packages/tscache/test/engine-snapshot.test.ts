import { describe, expect, it, vi } from "vitest";
import { Engine } from "../src/engine/engine";
import { InvalidRangeError, UnknownCacheError } from "../src/errors";
import type { Range, Snapshot } from "../src/types";
import { batch, engineConfig, result } from "./engine-test-helpers";
import { snapshotFixture, thrown } from "./snapshot-test-helpers";

describe("Engine snapshots — architecture §2.8, §4.6", () => {
  it("E01 synchronously delegates snapshots, snapshot-enabled reads and hydrate results", () => {
    const engine = new Engine();
    engine.cache(
      engineConfig({ id: "source", version: "seed", finalizedUntil: 33 }),
    );
    engine.cache(engineConfig({ id: "target" }));
    engine.put("source", batch([3, 13, 33], [10, Number.NaN, 30]));
    const range = { start: 3.25, end: 42.75 };
    const snapshot = engine.snapshot("source", range);
    expect(snapshot).toMatchObject({
      range: { start: 3, end: 43 },
      version: "seed",
      finalizedUntil: 33,
      coverage: [{ start: 3, end: 23 }],
    });
    const read = engine.get("source", range, { snapshot: true });
    expect(read.snapshot).toEqual(snapshot);
    expect(read.snapshot?.coverage).toEqual(read.coverage);
    expect(read).toMatchObject(
      result(
        [3, 13, 33],
        [{ start: 3, end: 23 }],
        [{ start: 33, end: 43 }],
        [10, Number.NaN, 30],
      ),
    );
    expect(engine.get("source", range)).not.toHaveProperty("snapshot");
    expect(engine.get("source", range, { snapshot: false })).not.toHaveProperty(
      "snapshot",
    );
    expect(engine.hydrate("target", snapshot)).toEqual({
      applied: [{ start: 3, end: 23 }],
    });
    expect(engine.get("target", range)).toEqual(
      result(
        [3, 13],
        [{ start: 3, end: 23 }],
        [{ start: 33, end: 43 }],
        [10, Number.NaN],
      ),
    );
    expect(engine.hydrate("target", snapshot)).toEqual({ applied: [] });
    expect(engine.snapshot("target", range)).toMatchObject({
      version: "seed",
      finalizedUntil: 33,
    });
  });

  it.each(["snapshot", "hydrate", "get"] as const)(
    "E02 %s checks an unknown cache before malformed input",
    (method) => {
      const engine = new Engine();
      const call = () =>
        method === "hydrate"
          ? engine.hydrate("absent", null as unknown as Snapshot)
          : method === "snapshot"
            ? engine.snapshot("absent", null as unknown as Range)
            : engine.get("absent", null as unknown as Range, {
                snapshot: true,
              });
      expect(call).toThrow(UnknownCacheError);
      expect(engine.has("absent")).toBe(false);
    },
  );

  it("E03 keeps CacheState validation errors and does not change either cache", () => {
    const engine = new Engine();
    for (const id of ["a", "b"]) {
      engine.cache(engineConfig({ id }));
      engine.put(id, batch([3, 13]));
    }
    const range = { start: -7, end: 73 };
    const beforeA = engine.get("a", range);
    const beforeB = engine.get("b", range);
    expect(() => engine.snapshot("a", { start: 23, end: 3 })).toThrow(
      InvalidRangeError,
    );
    expect(() =>
      engine.get("a", { start: 23, end: 3 }, { snapshot: true }),
    ).toThrow(InvalidRangeError);
    expect(
      thrown(() => engine.hydrate("a", { ...snapshotFixture(), interval: 11 }))
        .message,
    ).toMatch(/^invalid snapshot:/);
    expect(
      thrown(() =>
        engine.hydrate("a", {
          ...snapshotFixture(),
          segments: [{ ...snapshotFixture().segments[0], format: 2 }],
        } as unknown as Snapshot),
      ).message,
    ).toMatch(/^invalid segment payload:/);
    expect(engine.get("a", range)).toEqual(beforeA);
    expect(engine.get("b", range)).toEqual(beforeB);
  });

  it("E04 hydrate emits no cacheCleared event or warnings on adoption, replacement, repeat or mismatch", () => {
    const engine = new Engine();
    engine.cache(engineConfig({ id: "target", warnOnOverlapDiff: true }));
    engine.cache(engineConfig({ id: "newer", version: "live" }));
    const listener = vi.fn(() => {
      throw new Error("hydrate must never emit a clear");
    });
    engine.on("cacheCleared", listener);
    engine.put("target", batch([3, 13, 23, 43], [999, 999, 999, 999]));
    engine.invalidate("target", { start: 3, end: 43 });
    expect(engine.hydrate("target", snapshotFixture())).toEqual({
      applied: [{ start: 3, end: 43 }],
    });
    expect(engine.hydrate("target", snapshotFixture())).toEqual({
      applied: [],
    });
    expect(engine.hydrate("newer", snapshotFixture())).toEqual({
      applied: [],
      skipped: "version-mismatch",
    });
    expect(listener).not.toHaveBeenCalled();
    expect(engine.snapshot("newer", { start: 3, end: 43 }).version).toBe(
      "live",
    );
  });

  it("E05 a later fetch survives a stale same-version seed, and another cache is untouched", () => {
    const engine = new Engine();
    for (const id of ["target", "other"]) engine.cache(engineConfig({ id }));
    engine.put("target", {
      ...batch([13, 23], [1300, 2300]),
      meta: { version: "seed" },
    });
    engine.put("other", batch([3], [999]));
    const other = engine.get("other", { start: -7, end: 73 });
    expect(engine.hydrate("target", snapshotFixture())).toEqual({
      applied: [
        { start: 3, end: 3 },
        { start: 33, end: 43 },
      ],
    });
    expect(engine.get("target", { start: 3, end: 43 })).toEqual(
      result(
        [3, 13, 23, 43],
        [{ start: 3, end: 43 }],
        [],
        [10, 1300, 2300, 30],
        [1, 13, 23, 3],
      ),
    );
    expect(engine.get("other", { start: -7, end: 73 })).toEqual(other);
  });
});
