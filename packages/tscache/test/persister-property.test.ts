import { describe, expect, it } from "vitest";
import { Engine } from "../src/engine/engine";
import { Persister } from "../src/persist/persister";
import type { PageRecord } from "../src/persist/records";
import {
  clearAll,
  fakeTime,
  finish,
  harness,
  opened,
  tick,
  writes,
} from "./persist-harness";
import {
  all,
  batch,
  config,
  expectRecords,
  fixture,
  recordsOf,
  requireCache,
  requirePage,
  rng,
  state,
} from "./persist-test-helpers";

fakeTime();
describe("canonical memory, incremental plans and convergence (§4.10.6 a/b/c/g)", () => {
  it.each([38, 45, 61, 0x12345678])(
    "a/b: seeded operation sequence and reload seed=%i",
    async (seed) => {
      const random = rng(seed);
      const h = await opened({ segmentSlotCap: 16 });
      for (let i = 0; i < 100; i++) {
        const start = random(41) - 20;
        const end = Math.min(24, start + random(8));
        const times = Array.from(
          { length: end - start + 1 },
          (_, n) => start + n,
        ).filter(() => random(3) !== 0);
        switch (random(10)) {
          case 0:
            h.engine.put(
              "persist",
              batch(
                times,
                times.map(() => random(20)),
              ),
            );
            break;
          case 1:
            h.engine.put("persist", batch(times), { range: { start, end } });
            break;
          case 2:
            h.engine.put("persist", {
              ...batch(times),
              meta: { finalizedUntil: random(30) - 5 },
            });
            break;
          case 3:
            h.engine.put("persist", {
              ...batch(times),
              meta: { version: `v${random(3)}` },
            });
            break;
          case 4:
            h.engine.invalidate("persist", { start, end });
            break;
          case 5:
            h.engine.setFinalizedUntil("persist", random(41) - 10);
            break;
          case 6:
            h.engine.clear("persist");
            break;
          case 7: {
            const clearing = clearAll(h);
            await tick();
            await clearing;
            break;
          }
          case 8: {
            const donor = state({ segmentSlotCap: 16 });
            donor.put(batch(times), { range: { start, end } });
            h.engine.hydrate("persist", donor.snapshot(all));
            break;
          }
          case 9:
            h.engine.put("persist", batch([]));
            break;
        }
        await finish(h.persister.flush());
        expectRecords(h.store.records("persist"), h.engine);
        const reloaded = new Engine();
        reloaded.cache(config({ segmentSlotCap: 16 }));
        const p = new Persister(reloaded, async () => h.store);
        await p.open("persist");
        expect(reloaded.coverage("persist", all)).toEqual(
          h.engine.coverage("persist", all),
        );
        for (const covered of h.engine.coverage("persist", all))
          expect(reloaded.get("persist", covered)).toEqual(
            h.engine.get("persist", covered),
          );
        expectRecords(h.store.records("persist"), reloaded);
        // Reload is read-only here: no timer-driven job is needed for canonical records.
      }
    },
  );
  it("c/R4-2: invalidate followed by fresh authoritative put persists the new authority", async () => {
    const h = await opened();
    h.engine.put("persist", batch([0, 1, 2], [10, 10, 10]));
    await finish(h.persister.flush());
    h.store.log.length = 0;
    h.engine.invalidate("persist", { start: 1, end: 1 });
    h.engine.put("persist", batch([1], [20]), { range: { start: 1, end: 1 } });
    await finish(h.persister.flush());
    expectRecords(h.store.records("persist"), h.engine);
    const engine = new Engine();
    engine.cache(config());
    const p = new Persister(engine, async () => h.store);
    await p.open("persist");
    expect(engine.get("persist", { start: 1, end: 1 })).toMatchObject({
      coverage: [{ start: 1, end: 1 }],
      fields: { value: new Float64Array([20]) },
      misses: [],
    });
    expect(writes(h.store)).toHaveLength(1);
    expect(
      writes(h.store)[0]?.plan.putPages.map((page: PageRecord) => page.page),
    ).toEqual([0]);
  });
  it("c: changing a page puts only that page; wholly volatile put/hydrate no-ops write nothing", async () => {
    const h = await opened({ finalizedUntil: 20 });
    h.engine.put("persist", batch([0, 4, 8]));
    await finish(h.persister.flush());
    h.store.log.length = 0;
    h.engine.put("persist", batch([4], [99]));
    await finish(h.persister.flush());
    expect(
      writes(h.store)[0]?.plan.putPages.map((p: PageRecord) => p.page),
    ).toEqual([1]);
    expect(writes(h.store)[0]?.plan.deletePages).toEqual([
      { start: 1, end: 1 },
    ]);
    h.store.log.length = 0;
    h.engine.put("persist", batch([20], [50]));
    h.engine.hydrate("persist", state().snapshot(all));
    await tick(10000);
    await finish(h.persister.flush());
    expect(writes(h.store)).toEqual([]);
  });
  it.each([
    "full",
    "skipped-page",
    "version",
    "unversioned-record",
    "config",
    "orphan",
    "clipped",
    "creation-above",
    "creation-below",
    "gap",
    "evicted-page",
  ])("g: open and one flush converge from load outcome %s", async (outcome) => {
    const h = harness();
    const data = fixture({ finalizedUntil: 20 }, [0, 3, 4, 7]);
    let creation: Parameters<typeof config>[0] = {};
    switch (outcome) {
      case "skipped-page":
        requirePage(data).snapshot.format = 2 as never;
        break;
      case "version":
        requireCache(data).version = "old";
        for (const p of data.pages) p.snapshot.version = "old";
        creation = { version: "new" };
        break;
      case "unversioned-record":
        creation = { version: "new" };
        break;
      case "config":
        requireCache(data).config.gapSplitK++;
        break;
      case "orphan":
        data.cache = undefined;
        break;
      case "clipped":
        delete requireCache(data).finalizedUntil;
        creation = { finalizedUntil: 3 };
        break;
      case "creation-above":
        creation = { finalizedUntil: 30 };
        break;
      case "creation-below":
        creation = { finalizedUntil: 10 };
        break;
      case "gap":
        for (const p of data.pages) p.snapshot.segments = [];
        break;
      case "evicted-page":
        data.pages.shift();
        break;
    }
    h.store.seed("persist", data);
    h.engine.cache(config(creation));
    await h.persister.open("persist");
    await finish(h.persister.flush());
    expectRecords(h.store.records("persist"), h.engine);
    expect(h.stopped).toEqual([]);
    if (outcome === "evicted-page")
      expect(h.engine.get("persist", { start: 0, end: 0 }).misses).toEqual([
        { range: { start: 0, end: 0 }, reason: "uncached" },
      ]);
  });
  it.each([4, 5])(
    "canonical pages survive K versus K+1 missing slots (%i) and page boundaries",
    async (gap) => {
      const h = await opened({ segmentSlotCap: 16, gapSplitK: 4 });
      h.engine.put("persist", batch([-1, 0, gap + 1, 15, 16]));
      await finish(h.persister.flush());
      expectRecords(h.store.records("persist"), h.engine);
      const engine = new Engine();
      engine.cache(config({ segmentSlotCap: 16 }));
      const p = new Persister(engine, async () => h.store);
      await p.open("persist");
      expect(engine.get("persist", all)).toEqual(h.engine.get("persist", all));
      expect(recordsOf(engine)).toEqual(h.store.records("persist"));
    },
  );
});
