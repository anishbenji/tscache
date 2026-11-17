import { describe, expect, it } from "vitest";
import { cacheInternals } from "../src/engine/cache";
import { cacheStateOf, Engine } from "../src/engine/engine";
import type { Segment } from "../src/segment/types";
import { rng } from "./cache-model";
import { batch, config, span, times } from "./m3-memory-helpers";

/** What the segments hold, summed segment by segment (the walked figure). */
function walked(engine: Engine, cacheId: string): number {
  const { store } = cacheInternals(cacheStateOf(engine, cacheId));
  return store.segments.reduce((sum, s: Segment) => sum + s.bytes, 0);
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
});
