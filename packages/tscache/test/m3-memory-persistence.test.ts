import { describe, expect, it, vi } from "vitest";
import { Persister } from "../src/persist/persister";
import type { CacheConfig } from "../src/types";
import {
  batch,
  config,
  MemoryEngine,
  PAGE_BYTES,
  span,
  whole,
} from "./m3-memory-helpers";
import { fakeTime, finish, tick, writes } from "./persist-harness";
import { MemoryStore } from "./persist-memory-store";
import { recordsOf, rng, tracked } from "./persist-test-helpers";

fakeTime();

async function opened(overrides: Partial<CacheConfig> = {}, pages = 1) {
  const engine = new MemoryEngine({ memoryBudget: pages * PAGE_BYTES });
  const store = new MemoryStore();
  const stopped: { cacheId: string; reason: string }[] = [];
  const persister = new Persister(engine, async () => store, {
    debounceMs: 10,
    maxDelayMs: 20,
    timeoutMs: 25,
    onStopped: (event) => stopped.push(event),
  });
  engine.cache(config({ persist: true, ...overrides }));
  await persister.open("a");
  return { engine, store, stopped, persister };
}

async function reload(store: MemoryStore, pages = 1) {
  const engine = new MemoryEngine({ memoryBudget: pages * PAGE_BYTES });
  engine.cache(config({ persist: true }));
  const persister = new Persister(engine, async () => store);
  await persister.open("a");
  return { engine, persister };
}

describe("M3 persistence (design §5 test 15, E11 b)", () => {
  it("15: eviction deletes its disk record relaxed, increments no removal and makes durable wait for nothing", async () => {
    const h = await opened();
    h.engine.put("a", batch([0]));
    await finish(h.persister.flush());
    expect(h.store.records("a").pages.map((p) => p.page)).toEqual([0]);
    h.store.log.length = 0;
    h.engine.put("a", batch([4]));
    const gate = h.store.gate("write");
    const flushing = h.persister.flush();
    try {
      await tick();
      await gate.entered;
      // Eviction is not a removal, so this must answer while its flush is held.
      await h.persister.durable("a");
      expect(h.persister.removals("a")).toBe(0);
    } finally {
      gate.release();
      await flushing;
    }
    const plans = writes(h.store);
    expect(plans).toHaveLength(1);
    expect(plans[0]?.plan.strict).toBe(false);
    expect(h.store.records("a").pages.map((p) => p.page)).toEqual([1]);
    expect(h.store.records("a")).toEqual(recordsOf(h.engine, "a"));
    expect(h.stopped).toEqual([]);
  });

  it("15/N58: a true removal after eviction still waits for its strict transaction", async () => {
    const h = await opened();
    h.engine.put("a", batch([0, 4]));
    await finish(h.persister.flush());
    const before = h.persister.removals("a");
    const gate = h.store.gate("write");
    h.engine.invalidate("a", span(4));
    const durable = tracked(h.persister.durable("a"));
    try {
      await tick();
      await gate.entered;
      expect(h.persister.removals("a")).toBe(before + 1);
      expect(durable.done).toBe(false);
      expect(writes(h.store).at(-1)?.plan.strict).toBe(true);
    } finally {
      gate.release();
      await durable.promise;
    }
    expect(h.store.records("a")).toEqual(recordsOf(h.engine, "a"));
  });

  it("15/E10/E22: dirty pages are evictable, while zero-byte gap records stay persisted", async () => {
    const h = await opened();
    h.engine.put("a", batch([]), { range: span(-8, -1) });
    h.engine.put("a", batch([0]));
    h.engine.put("a", batch([4]));
    expect([...h.engine.get("a", whole).timestamps]).toEqual([4]);
    await finish(h.persister.flush());
    expect(h.store.records("a").pages.map((p) => p.page)).toEqual([-2, -1, 1]);
    expect(
      h.store
        .records("a")
        .pages.slice(0, 2)
        .every((p) => p.snapshot.segments.length === 0),
    ).toBe(true);
    expect(h.engine.memoryStats()).toMatchObject({
      bytes: PAGE_BYTES,
      pinnedBytes: 0,
    });
  });

  it.each([121, 67, 0x12345678])(
    "15 property (a): flush equals recordsOf(memory) through random evictions seed=%i",
    async (seed) => {
      const h = await opened({}, 2);
      const random = rng(seed);
      h.engine.cache(config({ id: "b", persist: true }));
      await h.persister.open("b");
      for (const slot of [0, 4, 8]) h.engine.put("a", batch([slot]));
      let version = 0;
      const operations = new Set<number>();
      for (let i = 0; i < 72; i++) {
        const id = i % 2 === 0 ? "a" : "b";
        const start = random(33) - 8;
        const end = start + random(6);
        const ts = Array.from(
          { length: end - start + 1 },
          (_, j) => start + j,
        ).filter(() => random(3) > 0);
        const operation = i < 9 ? i : random(9);
        operations.add(operation);
        switch (operation) {
          case 0:
            h.engine.put(id, batch(ts));
            break;
          case 1:
            h.engine.put(id, batch(ts), { range: span(start, end) });
            break;
          case 2:
            h.engine.invalidate(id, span(start, end));
            break;
          case 3:
            h.engine.setFinalizedUntil(id, i % 2 === 0 ? 0 : 40);
            break;
          case 4:
            h.engine.clear(id);
            break;
          case 5: {
            const donor = new MemoryEngine();
            donor.cache(config({ id, persist: true }));
            donor.put(id, batch(ts));
            h.engine.hydrate(id, donor.snapshot(id, whole));
            break;
          }
          case 6:
            h.engine.put(id, batch(ts, ts, { version: `v${++version}` }));
            break;
          case 7:
            h.engine.clearAll();
            await finish(h.persister.clearAll());
            break;
          case 8:
            h.engine.get(id, span(start, end));
            break;
        }
        await finish(h.persister.flush());
        for (const cacheId of ["a", "b"])
          expect(
            h.store.records(cacheId),
            `seed=${seed}, step=${i}, cache=${cacheId}`,
          ).toEqual(recordsOf(h.engine, cacheId));
        expect(h.stopped).toEqual([]);
      }
      expect(operations.size).toBe(9);
      expect(h.engine.memoryStats().evictedPages).toBeGreaterThan(0);
    },
  );

  it("10/15: eager restore trims before open answers and its next flush deletes the trimmed records", async () => {
    const donor = new MemoryEngine();
    donor.cache(config({ persist: true }));
    donor.put("a", batch([0, 4, 8, 12]));
    const store = new MemoryStore();
    store.seed("a", recordsOf(donor, "a"));
    const h = await reload(store, 2);
    expect([...h.engine.get("a", whole).timestamps]).toEqual([8, 12]);
    expect(h.engine.memoryStats()).toMatchObject({
      bytes: 2 * PAGE_BYTES,
      pinnedBytes: 0,
    });
    await finish(h.persister.flush());
    expect(store.records("a")).toEqual(recordsOf(h.engine, "a"));
    expect(store.records("a").pages.map((p) => p.page)).toEqual([2, 3]);
  });

  it.each(["cleanup succeeds", "cleanup fails"])(
    "15: deletion misses its deadline and %s",
    async (outcome) => {
      const h = await opened();
      h.engine.put("a", batch([0]));
      await finish(h.persister.flush());
      h.engine.cache(config({ id: "pressure" }));
      const old = h.store.records("a");
      h.store.log.length = 0;
      // Attempts due at 0, 10 and 20 fail; at 25 the deadline stops the
      // cache and the fourth write is the separate strict cleanup.
      h.store.fail("write", outcome === "cleanup succeeds" ? 3 : Infinity);
      h.engine.put("pressure", batch([4]));
      const flushing = h.persister.flush("a");
      await tick(25);
      await flushing;
      await h.persister.durable("a");
      expect(h.stopped).toHaveLength(1);
      expect(h.stopped[0]).toMatchObject({ cacheId: "a", reason: "error" });
      expect(h.persister.removals("a")).toBe(0);
      const attempts = writes(h.store);
      expect(attempts.slice(0, 3).every((call) => !call.plan.strict)).toBe(
        true,
      );
      expect(attempts.at(-1)?.plan).toEqual({
        deletePages: [span(-Infinity, Infinity)],
        putPages: [],
        putCache: null,
        strict: true,
      });
      expect(h.store.records("a")).toEqual(
        outcome === "cleanup succeeds" ? { cache: undefined, pages: [] } : old,
      );
      h.store.recover("write");
      const next = await reload(h.store);
      expect([...next.engine.get("a", whole).timestamps]).toEqual(
        outcome === "cleanup succeeds" ? [] : [0],
      );
      expect(next.engine.coverage("a", whole)).toEqual(
        outcome === "cleanup succeeds" ? [] : [span(0)],
      );
    },
  );

  it("15: termination before the eviction flush leaves a record that a later engine can load", async () => {
    const h = await opened();
    h.engine.put("a", batch([0], [99]));
    await finish(h.persister.flush());
    h.engine.cache(config({ id: "pressure" }));
    h.engine.put("pressure", batch([4]));
    expect(h.engine.get("a", span(0)).timestamps).toHaveLength(0);
    // Model realm termination: its scheduled work disappears. close()
    // would deliberately flush, so it is not the termination seam.
    vi.clearAllTimers();
    const next = await reload(h.store);
    expect([...next.engine.get("a", whole).timestamps]).toEqual([0]);
    expect(next.engine.get("a", span(0)).fields.value).toEqual(
      new Float64Array([99]),
    );
  });
});
