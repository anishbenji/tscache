import { afterEach, describe, expect, it, vi } from "vitest";
import { CacheState, cacheInternals } from "../src/engine/cache";
import {
  cacheStateOf,
  Engine,
  engineMemoryInternals,
  observeCaches,
} from "../src/engine/engine";
import { SegmentStore } from "../src/engine/merge";
import { resolveCacheConfig } from "../src/engine/validate";
import { ConfigError } from "../src/errors";
import { Orchestrator } from "../src/orchestrator/orchestrator";
import { DenseSegment } from "../src/segment/dense";
import type { Segment } from "../src/segment/types";
import { rng } from "./cache-model";
import {
  batch,
  config,
  fetcherModule,
  fetching,
  MemoryEngine,
  PAGE_BYTES,
  restore,
  span,
  times,
  whole,
} from "./m3-memory-helpers";
import { recordsOf } from "./persist-test-helpers";

afterEach(() => vi.restoreAllMocks());

function bytes(segment: Segment): number {
  return (segment as Segment & { readonly bytes: number }).bytes;
}
function storeBytes(store: SegmentStore): number {
  return (store as SegmentStore & { readonly bytes: number }).bytes;
}

describe("M3 engine contracts (design §5 tests 1–12)", () => {
  it("1: DenseSegment counts allocated capacity and mask, including spare capacity and all dtypes", () => {
    const fields = {
      a: "f64",
      b: "f32",
      c: "i32",
      d: "u32",
      e: "i16",
      f: "u16",
      g: "i8",
      h: "u8",
    } as const;
    const segment = new DenseSegment({
      grid: { interval: 1, alignmentOffset: 0 },
      fields,
      slotCap: 256,
    });
    const put = (slots: number[]) =>
      segment.mergeFrom({
        slots: new Float64Array(slots),
        fields: {
          a: new Float64Array(slots),
          b: new Float32Array(slots),
          c: new Int32Array(slots),
          d: new Uint32Array(slots),
          e: new Int16Array(slots),
          f: new Uint16Array(slots),
          g: new Int8Array(slots),
          h: new Uint8Array(slots),
        },
      });
    expect(bytes(segment)).toBe(0);
    put([0]);
    expect(bytes(segment)).toBe(64 * 26 + 8);
    put(times(0, 64));
    expect(bytes(segment)).toBe(128 * 26 + 16);
    put(times(-65, -1));
    expect(bytes(segment)).toBe(256 * 26 + 32);
    // Replacement clears values, but does not free allocated capacity.
    segment.mergeFrom(
      {
        slots: new Float64Array(),
        fields: {
          a: new Float64Array(),
          b: new Float32Array(),
          c: new Int32Array(),
          d: new Uint32Array(),
          e: new Int16Array(),
          f: new Uint16Array(),
          g: new Int8Array(),
          h: new Uint8Array(),
        },
      },
      span(-65, 64),
    );
    expect(bytes(segment)).toBe(256 * 26 + 32);
  });

  it.each([121, 0x51ce])(
    "1: random joins, K-splits, carves and growth agree with allocated bytes seed=%i",
    (seed) => {
      // cap <= the 64-slot minimum: every nonempty segment allocates exactly
      // cap slots, independently of its extent and of its merge history (§2).
      const e = new MemoryEngine();
      const c = config({ segmentSlotCap: 16 });
      e.cache(c);
      const store = cacheInternals(cacheStateOf(e, "a")).store;
      const random = rng(seed);
      const check = () => {
        const expected = store.segments.length * (16 * 8 + 2);
        expect(store.segments.map(bytes)).toEqual(
          store.segments.map(() => 130),
        );
        expect(storeBytes(store)).toBe(expected);
        expect(e.memoryStats()).toMatchObject({
          bytes: expected,
          pinnedBytes: 0,
          evictedPages: 0,
          caches: [
            {
              cacheId: "a",
              bytes: expected,
              pages: new Set(
                store.segments.map((s) =>
                  Math.floor((s.extent?.start ?? 0) / 16),
                ),
              ).size,
            },
          ],
        });
      };
      // Force each shape before the random suffix: dense, sparse, prepend,
      // append, join, K-split and an authoritative carve.
      for (const ts of [
        [0, 1],
        [9, 12],
        [-1, -2].sort((a, b) => a - b),
        [2, 3, 4, 5, 6, 7, 8],
        [16, 17],
      ]) {
        e.put("a", batch(ts));
        check();
      }
      e.put("a", batch([]), { range: span(3, 7) });
      check();
      for (let i = 0; i < 80; i++) {
        const start = random.int(-32, 40);
        const end = start + random.int(0, 15);
        const ts = times(start, end).filter(() => random.int(0, 2) !== 0);
        e.put("a", batch(ts), i % 2 === 0 ? { range: span(start, end) } : {});
        check();
      }
      e.clear("a");
      check();
      e.put("a", batch([0], [1], { version: "v1" }));
      e.put("a", batch([], [], { version: "v2" }));
      check();
      e.put("a", batch([0]));
      e.cache(config({ id: "z" }));
      e.put("z", batch([4]));
      e.clearAll();
      expect(e.memoryStats()).toMatchObject({
        bytes: 0,
        pinnedBytes: 0,
        caches: [
          { cacheId: "a", bytes: 0, pages: 0 },
          { cacheId: "z", bytes: 0, pages: 0 },
        ],
      });
    },
  );

  it("1: evictPage frees all segments of just that page and updates the store total", () => {
    const store = new SegmentStore(
      resolveCacheConfig(config({ gapSplitK: 1 })),
    );
    store.put({
      slots: new Float64Array([-1, 0, 3, 4]),
      fields: { value: new Float64Array([1, 2, 3, 4]) },
    });
    const eviction = store as SegmentStore & {
      evictPage(page: number): number;
    };
    expect(storeBytes(store)).toBe(4 * PAGE_BYTES);
    expect(eviction.evictPage(0)).toBe(2 * PAGE_BYTES);
    expect(storeBytes(store)).toBe(2 * PAGE_BYTES);
    expect(store.segments.map((s) => s.extent)).toEqual([span(-1), span(4)]);
    expect(eviction.evictPage(0)).toBe(0);
    store.clear();
    expect(storeBytes(store)).toBe(0);
  });

  it("2/A1: no budget does no bookkeeping or eviction and preserves mixed-call results", async () => {
    const evict = vi.spyOn(
      CacheState.prototype as CacheState & { evict(page: number): void },
      "evict",
    );
    const evictPage = vi.spyOn(
      SegmentStore.prototype as SegmentStore & {
        evictPage(page: number): number;
      },
      "evictPage",
    );
    const candidate = new MemoryEngine({});
    const baseline = new Engine();
    fetching();
    const a = new Orchestrator(candidate, () => {});
    const b = new Orchestrator(baseline, () => {});
    await a.load({ module: fetcherModule });
    await b.load({ module: fetcherModule });
    for (const e of [candidate, baseline]) {
      e.cache(config());
      e.cache(config({ id: "r" }));
    }
    const donor = new Engine();
    donor.cache(config());
    donor.put("a", batch([12, 13]));
    const snapshot = donor.snapshot("a", whole);
    for (let i = 0; i < 20; i++) {
      const ts = times(i * 4, i * 4 + 3);
      expect(candidate.put("a", batch(ts))).toEqual(
        baseline.put("a", batch(ts)),
      );
      expect(candidate.get("a", whole)).toEqual(baseline.get("a", whole));
      expect(await a.get("a", span(90, 93))).toEqual(
        await b.get("a", span(90, 93)),
      );
      expect(
        await a.get("a", whole, { cacheOnly: true, snapshot: true }),
      ).toEqual(await b.get("a", whole, { cacheOnly: true, snapshot: true }));
    }
    candidate.invalidate("a", span(12, 13));
    baseline.invalidate("a", span(12, 13));
    expect(candidate.hydrate("a", snapshot)).toEqual(
      baseline.hydrate("a", snapshot),
    );
    const rDonor = new Engine();
    rDonor.cache(config({ id: "r" }));
    rDonor.put("r", batch([0, 4]));
    restore(candidate, "r", recordsOf(rDonor, "r"));
    restore(baseline, "r", recordsOf(rDonor, "r"));
    for (const id of ["a", "r"]) {
      expect(candidate.get(id, whole)).toEqual(baseline.get(id, whole));
      expect(engineMemoryInternals(candidate).evictedIndex(id)).toBeUndefined();
    }
    expect(engineMemoryInternals(candidate)).toMatchObject({
      orderSize: 0,
      pinnedPages: 0,
    });
    expect(evict).not.toHaveBeenCalled();
    expect(evictPage).not.toHaveBeenCalled();
    expect(candidate.memoryStats().bytes).toBeGreaterThan(0);
    expect(candidate.memoryStats().pinnedBytes).toBe(0);
  });

  it.each([0, -1])(
    "3: exactly met budget keeps its page; one byte over evicts it (delta=%i)",
    (delta) => {
      const e = new MemoryEngine({ memoryBudget: PAGE_BYTES + delta });
      e.cache(config());
      e.put("a", batch([0]));
      expect(e.memoryStats()).toMatchObject({
        budget: PAGE_BYTES + delta,
        bytes: delta === 0 ? PAGE_BYTES : 0,
        evictedPages: delta === 0 ? 0 : 1,
      });
      expect([...e.get("a", span(0)).timestamps]).toEqual(
        delta === 0 ? [0] : [],
      );
    },
  );

  it("3: one engine-wide LRU chooses across caches and stats sort ids", () => {
    const e = new MemoryEngine({ memoryBudget: 2 * PAGE_BYTES });
    e.cache(config({ id: "z" }));
    e.cache(config());
    e.put("z", batch([0]));
    e.put("a", batch([4]));
    e.get("z", span(0));
    e.put("a", batch([8]));
    expect([...e.get("a", whole).timestamps]).toEqual([8]);
    expect([...e.get("z", whole).timestamps]).toEqual([0]);
    expect(e.memoryStats()).toEqual({
      budget: 2 * PAGE_BYTES,
      bytes: 2 * PAGE_BYTES,
      pinnedBytes: 0,
      evictedPages: 1,
      caches: [
        { cacheId: "a", bytes: PAGE_BYTES, pages: 1 },
        { cacheId: "z", bytes: PAGE_BYTES, pages: 1 },
      ],
    });
    expect(engineMemoryInternals(e)).toMatchObject({
      orderSize: 2,
      pinnedPages: 0,
    });
  });

  it.each(["get", "snapshot", "get snapshot", "put", "hydrate"])(
    "4: %s makes every overlapping point-holding page recent",
    (use) => {
      const e = new MemoryEngine({ memoryBudget: 2 * PAGE_BYTES });
      e.cache(config());
      e.put("a", batch([0]));
      e.put("a", batch([4]));
      switch (use) {
        case "get":
          e.get("a", span(3));
          break; // Page holds points, request need not hit one.
        case "snapshot":
          e.snapshot("a", span(0));
          break;
        case "get snapshot":
          e.get("a", span(0), { snapshot: true });
          break;
        case "put":
          e.put("a", batch([0], [10]));
          break;
        case "hydrate": {
          const donor = new Engine();
          donor.cache(config());
          donor.put("a", batch([0], [10]));
          e.invalidate("a", span(0));
          e.hydrate("a", donor.snapshot("a", span(0)));
          break;
        }
      }
      e.put("a", batch([8]));
      expect([...e.get("a", whole).timestamps]).toEqual([0, 8]);
    },
  );

  it.each([
    "coverage",
    "invalidate",
    "setFinalizedUntil",
    "memoryStats",
    "empty put",
    "idempotent hydrate",
    "skipped hydrate",
    "rejected put",
  ])("4: %s is not a use", (operation) => {
    const e = new MemoryEngine({ memoryBudget: 2 * PAGE_BYTES });
    e.cache(config({ version: "v1", finalizedUntil: 100 }));
    e.put("a", batch([0]));
    const snapshot = e.snapshot("a", span(0));
    e.put("a", batch([4]));
    switch (operation) {
      case "coverage":
        e.coverage("a", span(0));
        break;
      case "invalidate":
        e.invalidate("a", span(0));
        break;
      case "setFinalizedUntil":
        e.setFinalizedUntil("a", 101);
        break;
      case "memoryStats":
        e.memoryStats();
        break;
      case "empty put":
        e.put("a", batch([]));
        break;
      case "idempotent hydrate":
        e.hydrate("a", snapshot);
        break;
      case "skipped hydrate":
        e.hydrate("a", { ...snapshot, version: "v2" });
        break;
      case "rejected put":
        expect(() => e.put("a", batch([1, 0]))).toThrow();
        break;
    }
    e.put("a", batch([8]));
    expect([...e.get("a", whole).timestamps]).toEqual([4, 8]);
  });

  it.each([121, 67, 0xabcdef])(
    "5: coverage and covered points stay a subset of an unbudgeted engine seed=%i",
    (seed) => {
      const bounded = new MemoryEngine({ memoryBudget: 2 * PAGE_BYTES });
      const reference = new Engine();
      for (const e of [bounded, reference]) e.cache(config());
      const random = rng(seed);
      const seen = new Set<number>();
      // A2: one consistent backend per dataset version. Every response is
      // exactly that backend's points within its range, including real gaps.
      const truth = new Map<number, number>();
      const redraw = () => {
        truth.clear();
        for (let t = -8; t <= 15; t++)
          if (random.int(0, 3) > 0 || [-8, 0, 8].includes(t))
            truth.set(t, random.int(-10, 10));
      };
      redraw();
      const check = () => {
        for (let start = -8; start <= 15; start++)
          for (let end = start; end <= 15; end++) {
            const a = bounded.get("a", span(start, end));
            const b = reference.get("a", span(start, end));
            for (const range of a.coverage) {
              for (let slot = range.start; slot <= range.end; slot++) {
                expect(
                  b.coverage.some((r) => r.start <= slot && slot <= r.end),
                  `seed=${seed}, slot=${slot}`,
                ).toBe(true);
                // Compare absence too: a lost point must never become a confirmed gap.
                const ai = [...a.timestamps].indexOf(slot);
                const bi = [...b.timestamps].indexOf(slot);
                expect(ai === -1).toBe(bi === -1);
                if (ai !== -1)
                  expect(a.fields.value?.[ai]).toBe(b.fields.value?.[bi]);
              }
            }
            expect(a.misses.every((miss) => miss.reason === "uncached")).toBe(
              true,
            );
          }
      };
      // Guaranteed eviction before random operations (no vacuous subset property).
      for (const e of [bounded, reference])
        for (const slot of [-8, 0, 8])
          e.put("a", batch([slot], [truth.get(slot) as number]));
      check();
      for (let step = 0; step < 48; step++) {
        const start = random.int(-8, 12);
        const end = Math.min(15, start + random.int(0, 5));
        const ts = times(start, end).filter((t) => truth.has(t));
        const values = ts.map((t) => truth.get(t) as number);
        const operation = step < 6 ? step : random.int(0, 5);
        seen.add(operation);
        for (const e of [bounded, reference])
          switch (operation) {
            case 0:
              e.put("a", batch(ts, values));
              break;
            case 1:
              e.put("a", batch(ts, values), { range: span(start, end) });
              break;
            case 2:
              e.get("a", span(start, end));
              break;
            case 3:
              e.invalidate("a", span(start, end));
              break;
            case 4:
              e.setFinalizedUntil("a", randomWatermark(step));
              break;
            case 5:
              e.clear("a");
              break;
          }
        check();
        if (operation === 5) redraw();
      }
      expect(seen.size).toBe(6);
      expect(bounded.memoryStats().evictedPages).toBeGreaterThan(0);
      function randomWatermark(step: number): number {
        return step % 2 === 0 ? -3 : 16;
      }
    },
  );

  // A2: truth originally contains point 1; after its page is evicted, an
  // inconsistent implicit-range upsert [0, 2] omits it. An unbudgeted
  // engine retains point 1; a budgeted engine cannot recover it. Decided by
  // the user on 2026-11-17 (pending decision #85, option a; N96): with an
  // inconsistent backend a budgeted cache reflects the latest put, and the
  // subset property of test 5 holds for consistent backends only.
  it("5/A2: inconsistent upsert [0, 2] after eviction of point 1 answers what the latest put wrote", () => {
    const bounded = new MemoryEngine({ memoryBudget: PAGE_BYTES });
    const reference = new Engine();
    for (const e of [bounded, reference]) {
      e.cache(config());
      e.put("a", batch([0, 1, 2]));
      e.put("a", batch([4]));
    }
    // Page 0 was the least recently used: point 1 went with its coverage.
    expect(bounded.coverage("a", span(0, 3))).toEqual([]);
    expect(bounded.memoryStats().evictedPages).toBe(1);
    for (const e of [bounded, reference]) e.put("a", batch([0, 2]));
    expect(bounded.get("a", span(0, 2))).toMatchObject({
      timestamps: new Float64Array([0, 2]),
      coverage: [span(0, 2)],
      misses: [],
    });
    // The unbudgeted engine keeps its older point 1 inside the same
    // coverage: the two differ only because the backend contradicted itself.
    expect(reference.get("a", span(0, 2))).toMatchObject({
      timestamps: new Float64Array([0, 1, 2]),
      coverage: [span(0, 2)],
    });
  });

  it("6: whole-page coverage is withdrawn, including gaps, with neighbours and dataset metadata intact", () => {
    const e = new MemoryEngine({ memoryBudget: 2 * PAGE_BYTES });
    e.cache(config({ version: "v1", finalizedUntil: 100 }));
    e.put("a", batch([-4]), { range: span(-4, -1) });
    e.put("a", batch([0]), { range: span(0, 3) });
    e.get("a", span(-4));
    e.put("a", batch([4]), { range: span(4, 7) });
    const result = e.get("a", span(-4, 7));
    expect([...result.timestamps]).toEqual([-4, 4]);
    expect(result.coverage).toEqual([span(-4, -1), span(4, 7)]);
    expect(result.misses).toEqual([{ range: span(0, 3), reason: "uncached" }]);
    expect(e.get("a", span(1, 3))).toMatchObject({
      coverage: [],
      misses: [{ range: span(1, 3), reason: "uncached" }],
      timestamps: new Float64Array(),
    });
    expect(cacheStateOf(e, "a").version).toBe("v1");
    expect(cacheStateOf(e, "a").finalizedUntil).toBe(100);
  });

  it("7: volatile pages pin their allocated bytes once; watermark release trims without another write", () => {
    const e = new MemoryEngine({ memoryBudget: PAGE_BYTES });
    e.cache(config({ finalizedUntil: 3, gapSplitK: 4 }));
    e.put("a", batch([0, 3, 7]));
    expect([...e.get("a", whole).timestamps]).toEqual([0, 3, 7]);
    expect(e.memoryStats()).toMatchObject({
      bytes: 2 * PAGE_BYTES,
      pinnedBytes: 2 * PAGE_BYTES,
      evictedPages: 0,
    });
    expect(engineMemoryInternals(e).pinnedPages).toBe(2);
    e.setFinalizedUntil("a", 7); // page 0 unpins, page 1's boundary point remains provisional.
    expect(e.memoryStats()).toMatchObject({
      bytes: PAGE_BYTES,
      pinnedBytes: PAGE_BYTES,
      evictedPages: 1,
    });
    expect([...e.get("a", whole).timestamps]).toEqual([7]);
    e.setFinalizedUntil("a", 8);
    expect(e.memoryStats().pinnedBytes).toBe(0);
  });

  it.each(["put", "hydrate", "restore"])(
    "8/10: oversized %s evicts other caches first, then its own oldest pages",
    (operation) => {
      const e = new MemoryEngine({ memoryBudget: 2 * PAGE_BYTES });
      e.cache(config({ id: "old" }));
      e.cache(config());
      e.put("old", batch([40]));
      const donor = new Engine();
      donor.cache(config());
      donor.put("a", batch([0, 4, 8]));
      if (operation === "put") e.put("a", batch([0, 4, 8]));
      else if (operation === "hydrate")
        e.hydrate("a", donor.snapshot("a", whole));
      else restore(e, "a", recordsOf(donor, "a"));
      expect(e.memoryStats()).toMatchObject({
        bytes: 2 * PAGE_BYTES,
        pinnedBytes: 0,
        evictedPages: 2,
      });
      expect([...e.get("old", whole).timestamps]).toEqual([]);
      expect([...e.get("a", whole).timestamps]).toEqual([4, 8]);
    },
  );

  it("9: eviction reports only onEvict, never onMutate or remove/clear", () => {
    const e = new MemoryEngine({ memoryBudget: PAGE_BYTES });
    e.cache(config());
    e.cache(config({ id: "b" }));
    const change = vi.fn();
    const mutate = vi.fn();
    const evict = vi.fn();
    observeCaches(e, {
      onChange: change,
      onMutate: mutate,
      onEvict: evict,
    } as Parameters<typeof observeCaches>[1] & { onEvict: typeof evict });
    e.put("a", batch([0]), { range: span(0, 3) });
    change.mockClear();
    mutate.mockClear();
    e.put("b", batch([4]));
    expect(change.mock.calls.filter(([id]) => id === "a")).toEqual([]);
    expect(mutate.mock.calls.filter(([id]) => id === "a")).toEqual([]);
    expect(
      change.mock.calls.every(
        ([, event]) => event.kind !== "remove" && event.kind !== "clear",
      ),
    ).toBe(true);
    expect(evict).toHaveBeenCalledTimes(1);
    expect(evict).toHaveBeenCalledWith("a", [span(0, 3)]);
  });

  it("11: hydrate refills evicted coverage of the same version and makes it recent", () => {
    const e = new MemoryEngine({ memoryBudget: 2 * PAGE_BYTES });
    e.cache(config({ version: "v1" }));
    e.put("a", batch([0], [99]));
    const snapshot = e.snapshot("a", span(0));
    e.put("a", batch([4]));
    e.put("a", batch([8]));
    expect(e.coverage("a", span(0))).toEqual([]);
    expect(e.hydrate("a", snapshot)).toEqual({ applied: [span(0)] });
    e.put("a", batch([12]));
    expect([...e.get("a", whole).timestamps]).toEqual([0, 12]);
    expect(e.get("a", span(0)).fields.value).toEqual(new Float64Array([99]));
  });

  it.each([0, -1, 0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "12: invalid budget %s throws ConfigError",
    (memoryBudget) => {
      expect(() => new MemoryEngine({ memoryBudget })).toThrow(ConfigError);
    },
  );

  it("12: smallest positive and maximum safe budgets are accepted", () => {
    for (const memoryBudget of [1, Number.MAX_SAFE_INTEGER])
      expect(new MemoryEngine({ memoryBudget }).memoryStats().budget).toBe(
        memoryBudget,
      );
  });

  it("3/E22: confirmed-gap pages count zero, survive pressure and never enter the order", () => {
    const e = new MemoryEngine({ memoryBudget: PAGE_BYTES });
    e.cache(config());
    e.put("a", batch([]), { range: span(0, 39) });
    expect(e.memoryStats()).toMatchObject({
      bytes: 0,
      pinnedBytes: 0,
      caches: [{ cacheId: "a", bytes: 0, pages: 0 }],
    });
    expect(engineMemoryInternals(e).orderSize).toBe(0);
    e.put("a", batch([40, 44]));
    expect(e.coverage("a", span(0, 39))).toEqual([span(0, 39)]);
  });
});
