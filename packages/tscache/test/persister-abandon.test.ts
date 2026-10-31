import { describe, expect, it, vi } from "vitest";
import { CacheState } from "../src/engine/cache";
import { Engine } from "../src/engine/engine";
import { Persister } from "../src/persist/persister";
import {
  clearAll,
  fakeTime,
  finish,
  harness,
  tick,
  writes,
} from "./persist-harness";
import { deferred } from "./persist-memory-store";
import {
  all,
  allPages,
  batch,
  config,
  expectRecords,
  fixture,
  type RestoreCache,
  state,
  tracked,
} from "./persist-test-helpers";

fakeTime();
type Mutation = {
  name: string;
  run: (h: ReturnType<typeof harness>) => void;
  removal: boolean;
};
const mutations: Mutation[] = [
  {
    name: "put below watermark",
    run: ({ engine: e }) => {
      e.put("persist", batch([0], [20]));
    },
    removal: false,
  },
  {
    name: "put with meta below watermark",
    run: ({ engine: e }) => {
      e.put("persist", { ...batch([0], [20]), meta: { finalizedUntil: 100 } });
    },
    removal: false,
  },
  ...[false, true].map((ranged) => ({
    name: `R3-2 provisional put ranged=${ranged}`,
    run: ({ engine: e }: ReturnType<typeof harness>) => {
      e.put(
        "persist",
        batch([150], [20]),
        ranged ? { range: { start: 150, end: 150 } } : undefined,
      );
    },
    removal: false,
  })),
  {
    name: "empty put",
    run: ({ engine: e }) => {
      e.put("persist", batch([]));
    },
    removal: false,
  },
  {
    name: "hydrate applies",
    run: ({ engine: e }) => {
      const s = state();
      s.put(batch([0]));
      e.hydrate("persist", s.snapshot(all));
    },
    removal: false,
  },
  {
    name: "hydrate applies nothing",
    run: ({ engine: e }) => {
      e.hydrate("persist", state().snapshot(all));
    },
    removal: false,
  },
  {
    name: "hydrate version skipped",
    run: ({ engine: e }) => {
      const s = state({ version: "other" });
      s.put(batch([0]));
      e.hydrate("persist", s.snapshot(all));
    },
    removal: false,
  },
  {
    name: "invalidate",
    run: ({ engine: e }) => e.invalidate("persist", { start: 0, end: 0 }),
    removal: true,
  },
  {
    name: "watermark forwards",
    run: ({ engine: e }) => e.setFinalizedUntil("persist", 120),
    removal: false,
  },
  {
    name: "watermark backwards",
    run: ({ engine: e }) => e.setFinalizedUntil("persist", 80),
    removal: true,
  },
  {
    name: "watermark unchanged",
    run: ({ engine: e }) => e.setFinalizedUntil("persist", 100),
    removal: false,
  },
  { name: "clear", run: ({ engine: e }) => e.clear("persist"), removal: true },
];

describe("any mutation abandons a pending load (§4.10.5 rule 2, property h)", () => {
  it.each(mutations)("$name", async ({ name, run, removal }) => {
    const h = harness();
    h.engine.cache(config({ finalizedUntil: 100, version: "v1" }));
    const stored = fixture({ finalizedUntil: 200, version: "v1" }, [150]);
    for (const page of stored.pages)
      for (const segment of page.snapshot.segments)
        for (const field of segment.fields)
          new Float64Array(field.data).fill(10);
    h.store.seed("persist", stored);
    const restore = vi.spyOn(CacheState.prototype as RestoreCache, "restore");
    const read = h.store.gate("read");
    const opening = h.persister.open("persist");
    await tick();
    await read.entered;
    run(h);
    await opening; // Awaiting with the gate shut proves abandonment.
    expect(restore).not.toHaveBeenCalled();
    const write = h.store.gate("write");
    const durability = tracked(h.persister.durable("persist"));
    if (removal) {
      await tick();
      await tick();
      await write.entered;
      expect(durability.done).toBe(false);
    } else {
      await tick(999);
      expect(writes(h.store)).toHaveLength(0);
      await tick(1);
      await tick();
      await write.entered;
    }
    expect(writes(h.store)[0]?.plan).toMatchObject({
      deletePages: allPages,
      strict: removal,
    });
    read.release();
    await tick();
    expect(restore).not.toHaveBeenCalled();
    write.release();
    await tick();
    await finish(h.persister.flush());
    await durability.promise;
    expectRecords(h.store.records("persist"), h.engine);
    if (name.startsWith("R3-2")) {
      expect(
        h.engine.get("persist", { start: 150, end: 150 }).fields.value,
      ).toEqual(new Float64Array([20]));
      expect(h.store.records("persist")).toEqual({
        cache: undefined,
        pages: [],
      });
      const e = new Engine();
      e.cache(config());
      const p = new Persister(e, async () => h.store);
      await p.open("persist");
      expect(e.get("persist", { start: 150, end: 150 }).misses).toEqual([
        { range: { start: 150, end: 150 }, reason: "uncached" },
      ]);
    }
    await tick(10000);
    expect(h.stopped).toEqual([]); // Load timer was cancelled.
  });
  it("clearAll abandons load and its strict clear replaces the rewrite", async () => {
    const h = harness();
    h.engine.cache(config());
    h.store.seed("persist", fixture());
    const read = h.store.gate("read");
    const opening = h.persister.open("persist");
    await tick();
    await read.entered;
    const clearing = clearAll(h);
    await opening;
    await tick();
    await clearing;
    read.release();
    await tick();
    await finish(h.persister.flush());
    expect(h.engine.get("persist", all).timestamps).toEqual(new Float64Array());
    expect(writes(h.store)).toEqual([]);
    expect(h.store.records("persist")).toEqual({ cache: undefined, pages: [] });
  });
  it("mutation during store opening leaves read unissued", async () => {
    const h = harness();
    h.engine.cache(config());
    const store = deferred<typeof h.store>();
    const p = new Persister(h.engine, () => store.promise);
    const opening = p.open("persist");
    h.engine.put("persist", batch([]));
    await opening;
    store.resolve(h.store);
    await tick();
    expect(h.store.log.filter((c) => c.kind === "read")).toEqual([]);
    await finish(p.flush());
    expectRecords(h.store.records("persist"), h.engine);
  });
  it("untouched pending load writes nothing; change after restore is incremental", async () => {
    const h = harness();
    h.engine.cache(config());
    h.store.seed("persist", fixture());
    const read = h.store.gate("read");
    const opening = h.persister.open("persist");
    await tick();
    await read.entered;
    await tick(4999);
    expect(writes(h.store)).toEqual([]);
    read.release();
    await opening;
    h.engine.put("persist", batch([0], [42]));
    await finish(h.persister.flush());
    expect(writes(h.store)[0]?.plan.deletePages).toEqual([
      { start: 0, end: 0 },
    ]);
    expect(h.stopped).toEqual([]);
  });
  it("restore allocation failure stops with error and runs one cleanup", async () => {
    const h = harness();
    h.engine.cache(config());
    h.store.seed("persist", fixture());
    vi.spyOn(
      CacheState.prototype as RestoreCache,
      "restore",
    ).mockImplementation(() => {
      throw new RangeError("planted restore failure");
    });
    await h.persister.open("persist");
    await tick();
    await h.persister.durable("persist");
    expect(h.stopped).toEqual([
      {
        cacheId: "persist",
        reason: "error",
        error: { name: "RangeError", message: "planted restore failure" },
      },
    ]);
    expect(writes(h.store).map((c) => c.plan)).toEqual([
      { deletePages: allPages, putPages: [], putCache: null, strict: true },
    ]);
  });
});
