import { afterEach, describe, expect, it, vi } from "vitest";
import { cacheInternals, type ReaderChange } from "../src/engine/cache";
import {
  cacheStateOf,
  Engine,
  engineMemoryInternals,
  observeCaches,
} from "../src/engine/engine";
import type { Segment } from "../src/segment/types";
import { rng } from "./cache-model";
import {
  batch,
  config,
  PAGE_BYTES,
  restore,
  span,
  times,
} from "./m3-memory-helpers";
import { recordsOf } from "./persist-test-helpers";

/** What the segments hold, summed segment by segment (the walked figure). */
function walked(engine: Engine, cacheId: string): number {
  const { store } = cacheInternals(cacheStateOf(engine, cacheId));
  return store.segments.reduce((sum, s: Segment) => sum + s.bytes, 0);
}

afterEach(() => vi.unstubAllGlobals());

/**
 * The allocator seam of m7-change-failures.test.ts: the first sized
 * Uint8Array allocated once the point at `slot` holds `value` throws, so a
 * put fails after landing that prefix (N70).
 */
function failAfterPoint(
  engine: Engine,
  cacheId: string,
  slot: number,
  value: number,
  action: () => void,
): void {
  const fault = new RangeError("M3 injected allocation failure");
  const NativeUint8Array = Uint8Array;
  let armed = true;
  let caught: unknown;
  vi.stubGlobal(
    "Uint8Array",
    new Proxy(NativeUint8Array, {
      construct(target, args, newTarget) {
        if (armed && typeof args[0] === "number" && args[0] > 0) {
          // Read the store, not get(): a get is a use, which would put the
          // prefix's page in the use order by itself.
          const { store } = cacheInternals(cacheStateOf(engine, cacheId));
          const landed = store.segments.some(
            (segment) => segment.lookup(slot)?.value === value,
          );
          if (landed) {
            armed = false;
            throw fault;
          }
        }
        return Reflect.construct(target, args, newTarget);
      },
    }),
  );
  try {
    action();
  } catch (error) {
    caught = error;
  } finally {
    vi.unstubAllGlobals();
  }
  expect(armed, "the write must reach the injected failure").toBe(false);
  expect(caught).toBe(fault);
}

describe("M3 accounting with a budget (implementer's tests)", () => {
  it.each([7, 1121, 0xbeef])(
    "the running total equals the walked sum through random writes, removals and evictions seed=%i",
    (seed) => {
      // A budget large enough that most calls evict nothing, and small
      // enough that some do: both paths must keep the total exact.
      const engine = new Engine({ memoryBudget: 6 * (64 * 8 + 8) });
      engine.cache(config({ segmentSlotCap: 256, gapSplitK: 2 }));
      engine.cache(config({ id: "b", segmentSlotCap: 128, gapSplitK: 1 }));
      const random = rng(seed);
      let evicted = 0;
      for (let i = 0; i < 300; i++) {
        const id = random.int(0, 1) === 0 ? "a" : "b";
        const start = random.int(-1200, 1200);
        const end = start + random.int(0, 300);
        const ts = times(start, end).filter(() => random.int(0, 3) !== 0);
        switch (random.int(0, 5)) {
          case 0:
            engine.put(id, batch(ts));
            break;
          case 1:
            engine.put(id, batch(ts), { range: span(start, end) });
            break;
          case 2:
            engine.invalidate(id, span(start, end));
            break;
          case 3:
            engine.get(id, span(start, end));
            break;
          case 4:
            engine.put(id, batch([]), { range: span(start, end) });
            break;
          default:
            if (random.int(0, 9) === 0) engine.clear(id);
            break;
        }
        const stats = engine.memoryStats();
        const a = walked(engine, "a");
        const b = walked(engine, "b");
        expect(stats.caches.map((c) => c.bytes)).toEqual([a, b]);
        expect(stats.bytes).toBe(a + b);
        // Nothing is pinned here, so every call ends at or below the budget.
        expect(stats.bytes).toBeLessThanOrEqual(stats.budget as number);
        evicted = stats.evictedPages;
      }
      expect(evicted).toBeGreaterThan(0);
    },
  );

  it("an engine budgeted by the internal op takes the first budget only while it holds no cache", async () => {
    const { applyMemoryBudget } = await import("../src/engine/engine");
    const engine = new Engine();
    expect(applyMemoryBudget(engine, 100)).toBe(100);
    expect(applyMemoryBudget(engine, 200)).toBe(100);
    expect(() => applyMemoryBudget(engine, 0)).toThrow(/memoryBudget/);
    const late = new Engine();
    late.cache(config());
    expect(applyMemoryBudget(late, 100)).toBeUndefined();
    expect(late.memoryStats()).not.toHaveProperty("budget");
  });

  it("a restore that trims its own pages reports nothing for that cache, and another cache's evictions once", () => {
    const engine = new Engine({ memoryBudget: 2 * PAGE_BYTES });
    const reports: [string, ReaderChange][] = [];
    observeCaches(engine, {
      onChange: () => {},
      onMutate: () => {},
      hasReaders: () => true,
      onReaderChange: (cacheId, change) => reports.push([cacheId, change]),
    });
    engine.cache(config({ id: "old" }));
    engine.cache(config());
    engine.put("old", batch([40]), { range: span(40, 43) });
    reports.length = 0;
    const donor = new Engine();
    donor.cache(config());
    donor.put("a", batch([0, 4, 8]), { range: span(0, 11) });
    restore(engine, "a", recordsOf(donor, "a"));
    expect(engine.memoryStats()).toMatchObject({ evictedPages: 2 });
    expect(reports).toEqual([
      [
        "old",
        { written: [], removed: [], cleared: false, evicted: [span(40, 43)] },
      ],
    ]);
  });

  it("a failed put under a budget: written over its slots, nothing removed, the total exact and its landed prefix in the use order", () => {
    const engine = new Engine({ memoryBudget: PAGE_BYTES });
    const reports: [string, ReaderChange][] = [];
    observeCaches(engine, {
      onChange: () => {},
      onMutate: () => {},
      hasReaders: () => true,
      onReaderChange: (cacheId, change) => reports.push([cacheId, change]),
    });
    engine.cache(config());
    engine.put("a", batch([0]), { range: span(0, 3) });
    // Evicts page 0: [0, 3] goes to the evicted-coverage index.
    engine.put("a", batch([4]), { range: span(4, 7) });
    expect(engineMemoryInternals(engine).evictedIndex("a")?.ranges()).toEqual([
      span(0, 3),
    ]);
    reports.length = 0;
    // Two write runs (gapSplitK 1): the first lands point 0, the second fails.
    failAfterPoint(engine, "a", 0, 7, () =>
      engine.put("a", batch([0, 3], [7, 8])),
    );
    // The put dropped [0, 3] from the index before writing, so its failure
    // withdraws nothing; the enforcement then evicts the older page [4, 7]
    // for the landed prefix (N102).
    expect(reports).toEqual([
      [
        "a",
        {
          written: [span(0, 3)],
          removed: [],
          cleared: false,
          evicted: [span(4, 7)],
        },
      ],
    ]);
    expect(engineMemoryInternals(engine).evictedIndex("a")?.ranges()).toEqual([
      span(4, 7),
    ]);
    const stats = engine.memoryStats();
    expect(stats.bytes).toBe(walked(engine, "a"));
    expect(stats.bytes).toBe(PAGE_BYTES);
    expect(engineMemoryInternals(engine).orderSize).toBe(1);
    expect([...engine.get("a", span(0, 7)).timestamps]).toEqual([0]);
    // The prefix's page is in the order: the next write evicts it.
    engine.put("a", batch([8]));
    expect([...engine.get("a", span(0, 11)).timestamps]).toEqual([8]);
  });

  it("a failed sparse upsert uses only the pages its landed prefix wrote (round 3, R3-2)", () => {
    const engine = new Engine({ memoryBudget: 4 * PAGE_BYTES });
    engine.cache(config());
    engine.cache(config({ id: "b" }));
    engine.put("a", batch([12]));
    engine.put("b", batch([0]));
    engine.put("a", batch([0]));
    engine.put("a", batch([4]));
    // Slot 0 lands in its existing segment; slot 8 needs a new one, whose
    // allocation fails, so the write never reaches slot 12's page.
    failAfterPoint(engine, "a", 0, 7, () =>
      engine.put("a", batch([0, 8, 12], [7, 8, 9])),
    );
    engine.put("b", batch([4]));
    expect([...engine.get("a", span(0, 15)).timestamps]).toEqual([0, 4]);
    expect([...engine.get("b", span(0, 15)).timestamps]).toEqual([0, 4]);
  });
});

describe("M3 restore-trimmed coverage (step 131)", () => {
  function threePageDonor(): Engine {
    const donor = new Engine();
    donor.cache(config());
    donor.put("a", batch([0, 4, 8]), { range: span(0, 11) });
    return donor;
  }

  function recordReaderChanges(engine: Engine): [string, ReaderChange][] {
    const reports: [string, ReaderChange][] = [];
    observeCaches(engine, {
      onChange: () => {},
      onMutate: () => {},
      hasReaders: () => true,
      onReaderChange: (cacheId, change) => reports.push([cacheId, change]),
    });
    return reports;
  }

  it("keeps a restore's own trimmed page out of the evicted index and later reader changes", () => {
    const engine = new Engine({ memoryBudget: 2 * PAGE_BYTES });
    engine.cache(config());
    const reports = recordReaderChanges(engine);
    restore(engine, "a", recordsOf(threePageDonor(), "a"));
    expect(engine.coverage("a", span(0, 11))).toEqual([span(4, 11)]);
    const evictedCoverage = engineMemoryInternals(engine)
      .evictedIndex("a")
      ?.ranges();

    // The first call touches only trimmed slots. The second also withdraws
    // one surviving slot, so readers should hear exactly that withdrawal.
    engine.invalidate("a", span(0, 2));
    engine.invalidate("a", span(3, 4));
    expect({ evictedCoverage, reports }).toStrictEqual({
      evictedCoverage: [],
      reports: [["a", { written: [], removed: [span(4)], cleared: false }]],
    });
  });

  it("remembers another cache's page evicted during restore and reports it on removal", () => {
    const engine = new Engine({ memoryBudget: 2 * PAGE_BYTES });
    engine.cache(config({ id: "old" }));
    engine.cache(config());
    const otherPage = span(40, 43);
    engine.put("old", batch([40]), { range: otherPage });
    const reports = recordReaderChanges(engine);

    restore(engine, "a", recordsOf(threePageDonor(), "a"));
    expect(engineMemoryInternals(engine).evictedIndex("old")?.ranges()).toEqual(
      [otherPage],
    );
    engine.invalidate("old", otherPage);
    expect(reports).toEqual([
      [
        "old",
        { written: [], removed: [], cleared: false, evicted: [otherPage] },
      ],
      ["old", { written: [], removed: [otherPage], cleared: false }],
    ]);
  });

  it("reports the page hydrate trims in its own reader change", () => {
    const engine = new Engine({ memoryBudget: 2 * PAGE_BYTES });
    engine.cache(config());
    const reports = recordReaderChanges(engine);
    const range = span(0, 11);

    engine.hydrate("a", threePageDonor().snapshot("a", range));
    expect(reports).toEqual([
      [
        "a",
        {
          written: [range],
          removed: [],
          cleared: false,
          evicted: [span(0, 3)],
        },
      ],
    ]);
  });
});
