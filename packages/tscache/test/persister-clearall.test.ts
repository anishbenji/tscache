import { describe, expect, it } from "vitest";
import { Engine } from "../src/engine/engine";
import { Persister } from "../src/persist/persister";
import {
  clearAll,
  fakeTime,
  finish,
  opened,
  tick,
  writes,
} from "./persist-harness";
import {
  all,
  allPages,
  batch,
  config,
  expectRecords,
  fixture,
  rng,
  tracked,
} from "./persist-test-helpers";

fakeTime();
describe("clearAll is a writer barrier (§4.10.6 h2/i–n; rounds 5–6)", () => {
  it.each([true, false])(
    "h2: a new cache starts cold during clear; success=%s",
    async (success) => {
      const h = await opened();
      h.store.seed("B", fixture({ id: "B" }, [0]));
      h.store.seed("C", fixture({ id: "C" }, [4]));
      if (!success) h.store.fail("clearAll", Infinity);
      const gate = h.store.gate("clearAll");
      const clearing = clearAll(h);
      await tick();
      await tick();
      await gate.entered;
      const openings = h.openStore.mock.calls.length;
      const reads = h.store.log.filter((c) => c.kind === "read").length;
      h.engine.cache(config({ id: "B" }));
      await h.persister.open("B");
      expect(h.openStore).toHaveBeenCalledTimes(openings);
      expect(h.store.log.filter((c) => c.kind === "read")).toHaveLength(reads);
      expect(h.engine.get("B", all).timestamps).toEqual(new Float64Array());
      h.engine.put("B", batch([1], [42]));
      const flushing = tracked(h.persister.flush("B"));
      await tick(500);
      expect(flushing.done).toBe(false);
      expect(writes(h.store)).toEqual([]);
      gate.release();
      await tick(success ? 0 : 4500);
      await clearing;
      await flushing.promise;
      if (success) {
        expect(writes(h.store)[0]?.plan.deletePages).toEqual(allPages);
        expectRecords(h.store.records("B"), h.engine, "B");
        h.store.seed("C", fixture({ id: "C" }, [7]));
        h.engine.cache(config({ id: "C" }));
        await h.persister.open("C");
        expect(h.engine.get("C", { start: 7, end: 7 }).fields.value).toEqual(
          new Float64Array([7]),
        );
      } else {
        expect(writes(h.store)).toEqual([]);
        expect(h.stopped.map((e) => e.cacheId).sort()).toEqual([
          "B",
          "persist",
        ]);
        const before = h.store.log.length;
        h.engine.cache(config({ id: "C" }));
        await h.persister.open("C");
        expect(h.store.log).toHaveLength(before);
        expect(h.stopped.at(-1)).toEqual({ ...h.stopped[0], cacheId: "C" });
      }
    },
  );
  it.each([1, Infinity])(
    "i/R6-1: no write between rejected clear and retry; failures=%s",
    async (failures) => {
      const h = await opened();
      h.engine.put("persist", batch([0, 1], [10, 10]));
      await finish(h.persister.flush());
      h.store.log.length = 0;
      h.store.fail("clearAll", failures);
      const clearing = tracked(clearAll(h));
      await tick();
      await tick(100);
      h.engine.put("persist", batch([0], [20]));
      h.engine.invalidate("persist", { start: 1, end: 1 });
      const durable = tracked(h.persister.durable("persist"));
      await tick(899);
      expect(writes(h.store)).toEqual([]);
      expect(durable.done).toBe(false);
      expect(clearing.done).toBe(false);
      if (failures === 1) {
        // Hold the post-barrier flush so durability is proved by the clear itself.
        const write = h.store.gate("write");
        await tick(1);
        await clearing.promise;
        await durable.promise;
        expect(h.store.log.filter((c) => c.kind === "clearAll")).toHaveLength(
          2,
        );
        const flush = h.persister.flush();
        await tick();
        await write.entered;
        expect(durable.done).toBe(true);
        expect(writes(h.store)[0]?.plan.strict).toBe(false);
        write.release();
        await flush;
        expectRecords(h.store.records("persist"), h.engine);
        const engine = new Engine();
        engine.cache(config());
        const p = new Persister(engine, async () => h.store);
        await p.open("persist");
        expect(engine.get("persist", { start: 0, end: 1 })).toMatchObject({
          timestamps: new Float64Array([0]),
          fields: { value: new Float64Array([20]) },
          coverage: [{ start: 0, end: 0 }],
        });
      } else {
        await tick(4001);
        await clearing.promise;
        await durable.promise;
        expect(writes(h.store)).toEqual([]);
        expect(h.stopped).toHaveLength(1);
        expect(h.stopped[0]?.reason).toBe("error");
      }
    },
  );
  it.each(["UnknownError", "QuotaExceededError", "hung"])(
    "j: an attempt running at the call is final: %s",
    async (outcome) => {
      const h = await opened();
      h.engine.put("persist", batch([0]));
      const gate = h.store.gate("write");
      const flush = h.persister.flush();
      await tick();
      await gate.entered;
      const clearing = tracked(clearAll(h));
      await tick();
      if (outcome === "hung") {
        await tick(5000);
        await flush;
        // The clear may time out too; that failure, unlike the final flush, stops.
        expect(h.stopped.every((e) => e.reason !== "quota-exceeded")).toBe(
          true,
        );
        expect(writes(h.store)).toHaveLength(1);
        gate.release();
        await tick();
        await clearing.promise;
      } else {
        gate.reject(
          Object.assign(new Error("final attempt rejected"), { name: outcome }),
        );
        await flush;
        await tick();
        await clearing.promise;
        expect(h.stopped).toEqual([]);
        expect(writes(h.store)).toHaveLength(1);
        await tick(10000);
        expect(writes(h.store)).toHaveLength(1);
      }
    },
  );
  it("j: final running attempt reaching its deadline does not stop its cache when clear still has time", async () => {
    const h = await opened();
    h.engine.put("persist", batch([0]));
    const gate = h.store.gate("write");
    const flush = h.persister.flush();
    await tick();
    await gate.entered;
    await tick(1000);
    const clearing = clearAll(h);
    await tick(4000);
    await flush;
    expect(h.stopped).toEqual([]);
    expect(h.store.log.filter((c) => c.kind === "clearAll")).toHaveLength(1);
    gate.release();
    await tick();
    await clearing;
    expect(h.stopped).toEqual([]);
    expect(writes(h.store)).toHaveLength(1);
  });
  it("j: queued flush and scheduled retry are absorbed; their waiters join clear settlement", async () => {
    const h = await opened();
    h.engine.cache(config({ id: "B" }));
    await h.persister.open("B");
    h.store.fail("write", 1);
    h.engine.put("persist", batch([0]));
    const retry = tracked(h.persister.flush("persist"));
    await tick();
    h.engine.cache(config({ id: "C" }));
    await h.persister.open("C");
    h.engine.put("C", batch([0]));
    const running = h.store.gate("write");
    const current = h.persister.flush("C");
    await tick();
    await running.entered;
    h.engine.put("B", batch([4]));
    const queued = tracked(h.persister.flush("B"));
    const gate = h.store.gate("clearAll");
    const clearing = clearAll(h);
    running.release();
    await current;
    await tick();
    await gate.entered;
    expect(retry.done).toBe(false);
    expect(queued.done).toBe(false);
    const count = writes(h.store).length;
    await tick(1000);
    expect(writes(h.store)).toHaveLength(count);
    gate.release();
    await clearing;
    await Promise.all([retry.promise, queued.promise]);
    await tick(10000);
    expect(writes(h.store)).toHaveLength(count);
    expect(h.stopped).toEqual([]);
  });
  it("j: cleanup queued before the call runs before the first clear attempt", async () => {
    const h = await opened();
    h.engine.cache(config({ id: "B" }));
    await h.persister.open("B");
    h.engine.put("persist", batch([0]));
    const running = h.store.gate("write");
    const flushing = h.persister.flush();
    await tick();
    await running.entered;
    // B's failed load queues a cleanup while the writer is occupied by A.
    h.engine.cache(config({ id: "C" }));
    h.store.fail("read", 1);
    await h.persister.open("C");
    const clearing = clearAll(h);
    running.release();
    await flushing;
    await tick();
    await clearing;
    expect(
      h.store.log
        .filter((c) => c.kind !== "read")
        .map((c) => (c.kind === "write" ? `${c.kind}:${c.cacheId}` : c.kind)),
    ).toEqual(["write:persist", "write:C", "clearAll"]);
  });
  it("j: a queued removal becomes durable at clear success without a cache write", async () => {
    const h = await opened();
    h.engine.put("persist", batch([0]));
    await finish(h.persister.flush());
    h.store.log.length = 0;
    h.engine.invalidate("persist", { start: 0, end: 0 });
    const durable = tracked(h.persister.durable("persist"));
    const gate = h.store.gate("clearAll");
    const clearing = clearAll(h);
    await tick();
    await tick();
    await gate.entered;
    expect(durable.done).toBe(false);
    gate.release();
    await clearing;
    await durable.promise;
    expect(writes(h.store)).toEqual([]);
  });
  it("k: held requests get a fresh deadline from settlement, after a 4999ms barrier", async () => {
    const h = await opened();
    const clear = h.store.gate("clearAll");
    const clearing = clearAll(h);
    await tick();
    await tick();
    await clear.entered;
    await tick(10);
    h.engine.put("persist", batch([0]));
    await tick(4989);
    const write = h.store.gate("write");
    clear.release();
    await clearing;
    await tick();
    await tick();
    await write.entered;
    await tick(2000);
    expect(h.stopped).toEqual([]);
    write.release();
    await tick();
    await finish(h.persister.flush());
    expectRecords(h.store.records("persist"), h.engine);
  });
  it("k: maxDelayMs cap passing during barrier makes the flush due at settlement", async () => {
    const h = await opened({}, { maxDelayMs: 2000 });
    const clear = h.store.gate("clearAll");
    const clearing = clearAll(h);
    await tick();
    await tick();
    await clear.entered;
    await tick(10);
    for (let i = 0; i < 9; i++) {
      h.engine.put("persist", batch([i]));
      await tick(500);
    }
    await tick(489);
    h.engine.put("persist", batch([9]));
    expect(writes(h.store)).toEqual([]);
    const write = h.store.gate("write");
    clear.release();
    await clearing;
    await tick();
    await tick();
    await write.entered;
    write.release();
    await tick();
    expectRecords(h.store.records("persist"), h.engine);
    expect(h.stopped).toEqual([]);
  });
  it.each(["invalidate", "clear", "watermark-back", "version"])(
    "l: %s during barrier is durable at settlement; next plan is relaxed",
    async (operation) => {
      const h = await opened({ finalizedUntil: 20, version: "v1" });
      const gate = h.store.gate("clearAll");
      const clearing = clearAll(h);
      await tick();
      await tick();
      await gate.entered;
      await tick(100);
      h.engine.put("persist", batch([0, 7]));
      switch (operation) {
        case "invalidate":
          h.engine.invalidate("persist", { start: 7, end: 7 });
          break;
        case "clear":
          h.engine.clear("persist");
          break;
        case "watermark-back":
          h.engine.setFinalizedUntil("persist", 5);
          break;
        case "version":
          h.engine.put("persist", { ...batch([0]), meta: { version: "v2" } });
          break;
      }
      const durable = tracked(h.persister.durable("persist"));
      await tick(100);
      expect(durable.done).toBe(false);
      expect(writes(h.store)).toEqual([]);
      const next = h.store.gate("write");
      gate.release();
      await clearing;
      await durable.promise;
      h.engine.put("persist", batch([1]));
      const flush = h.persister.flush();
      await tick();
      await next.entered;
      expect(writes(h.store)[0]?.plan.strict).toBe(false);
      next.release();
      await flush;
      expectRecords(h.store.records("persist"), h.engine);
    },
  );
  it.each(["queued", "between attempts", "during attempt"])(
    "m: second clear while %s joins the first deadline and attempts",
    async (phase) => {
      const h = await opened();
      let release: (() => void) | undefined;
      if (phase === "queued") {
        h.engine.put("persist", batch([0]));
        const running = h.store.gate("write");
        void h.persister.flush();
        await tick();
        await running.entered;
        release = running.release;
      }
      if (phase === "between attempts") h.store.fail("clearAll", Infinity);
      const gate =
        phase === "during attempt" ? h.store.gate("clearAll") : undefined;
      const first = tracked(clearAll(h));
      await tick();
      if (gate !== undefined) await gate.entered;
      await tick(700);
      const second = tracked(clearAll(h));
      await tick();
      expect(first.done).toBe(false);
      expect(second.done).toBe(false);
      if (phase === "between attempts") {
        await tick(4299);
        expect(second.done).toBe(false);
        await tick(1);
        await Promise.all([first.promise, second.promise]);
        expect(h.store.log.filter((c) => c.kind === "clearAll")).toHaveLength(
          5,
        );
        expect(h.stopped).toHaveLength(1);
      } else {
        release?.();
        gate?.release();
        await tick();
        await Promise.all([first.promise, second.promise]);
        expect(h.store.log.filter((c) => c.kind === "clearAll")).toHaveLength(
          1,
        );
        expect(h.stopped).toEqual([]);
      }
    },
  );
  it("n: failed clear stops all tracked and later opens once, no reads/cleanup; later clear still runs", async () => {
    const h = await opened();
    h.store.fail("clearAll", Infinity);
    const clearing = clearAll(h);
    await tick();
    h.engine.cache(config({ id: "during" }));
    await h.persister.open("during");
    await tick(5000);
    await clearing;
    expect(h.stopped.map((e) => e.cacheId).sort()).toEqual([
      "during",
      "persist",
    ]);
    expect(writes(h.store)).toEqual([]);
    const count = h.store.log.length;
    h.engine.cache(config({ id: "later" }));
    await h.persister.open("later");
    await h.persister.open("later");
    expect(h.store.log).toHaveLength(count);
    expect(h.stopped.filter((e) => e.cacheId === "later")).toHaveLength(1);
    expect(h.stopped.at(-1)).toEqual({ ...h.stopped[0], cacheId: "later" });
    h.store.recover("clearAll");
    const again = clearAll(h);
    await tick();
    await again;
    expect(h.store.log.at(-1)?.kind).toBe("clearAll");
    expect(h.stopped).toHaveLength(3);
    expect(writes(h.store)).toEqual([]);
  });
  it.each(["before removal", "after removal"])(
    "f: rejected or hung clear %s keeps durable under two deadlines",
    async (order) => {
      for (const held of [false, true]) {
        const h = await opened();
        h.engine.put("persist", batch([0]));
        await finish(h.persister.flush());
        const gate = held ? h.store.gate("clearAll") : undefined;
        if (!held) h.store.fail("clearAll", Infinity);
        let clearing: Promise<void>;
        if (order === "before removal") {
          clearing = clearAll(h);
          await tick();
          h.engine.invalidate("persist", { start: 0, end: 0 });
        } else {
          h.engine.invalidate("persist", { start: 0, end: 0 });
          clearing = clearAll(h);
        }
        const durable = h.persister.durable("persist");
        await tick(10000);
        await durable;
        await clearing;
        expect(h.stopped).toHaveLength(1);
        gate?.release();
        await tick();
      }
    },
  );
  it.each([38, 6101, 0xabcdef])(
    "i: seeded barrier interleavings seed=%i start no read/write until settlement",
    async (seed) => {
      const random = rng(seed);
      const h = await opened();
      for (let round = 0; round < 12; round++) {
        h.store.fail("clearAll", random(3));
        const gate = h.store.gate("clearAll");
        const clearing = clearAll(h);
        const boundary = h.store.log.length;
        await tick();
        await tick();
        await gate.entered;
        const flushes: Promise<void>[] = [];
        for (let i = 0; i < 12; i++) {
          const id = `cold-${round}-${i}`;
          switch (random(5)) {
            case 0:
              h.engine.put("persist", batch([random(8)]));
              break;
            case 1:
              h.engine.invalidate("persist", { start: 0, end: 0 });
              break;
            case 2:
              flushes.push(h.persister.flush());
              break;
            case 3:
              h.engine.cache(config({ id }));
              await h.persister.open(id);
              break;
            case 4:
              h.engine.setFinalizedUntil("persist", 8 + random(8));
              break;
          }
          await tick(random(25));
        }
        expect(
          h.store.log.slice(boundary).every((c) => c.kind === "clearAll"),
        ).toBe(true);
        gate.release();
        await tick(3000);
        await clearing;
        await Promise.all(flushes);
        await finish(h.persister.flush());
        expect(h.stopped).toEqual([]);
        expectRecords(h.store.records("persist"), h.engine);
      }
    },
  );
});

describe("clear barrier failure edges (§4.10.6 l/n)", () => {
  it.each(["invalidate", "clear", "watermark-back", "version"])(
    "l: %s during a failing barrier resolves through its stop without cleanup",
    async (op) => {
      const h = await opened({ version: "v1", finalizedUntil: 20 });
      h.store.fail("clearAll", Infinity);
      const clearing = tracked(clearAll(h));
      await tick(100);
      h.engine.put("persist", batch([0, 7]));
      if (op === "invalidate")
        h.engine.invalidate("persist", { start: 7, end: 7 });
      if (op === "clear") h.engine.clear("persist");
      if (op === "watermark-back") h.engine.setFinalizedUntil("persist", 5);
      if (op === "version")
        h.engine.put("persist", { ...batch([0]), meta: { version: "v2" } });
      const durable = tracked(h.persister.durable("persist"));
      await tick(4899);
      expect(durable.done).toBe(false);
      expect(clearing.done).toBe(false);
      expect(writes(h.store)).toEqual([]);
      await tick(1);
      await durable.promise;
      await clearing.promise;
      expect(h.stopped).toHaveLength(1);
      expect(writes(h.store)).toEqual([]);
    },
  );
});

describe("barrier before the first store opening (§4.10.5 rule 3, §4.10.6)", () => {
  it("a cold open starts no competing store opening; after an absent database its held flush creates one", async () => {
    const engine = new Engine();
    const { MemoryStore, deferred } = await import("./persist-memory-store");
    const store = new MemoryStore();
    const first = deferred<typeof store | undefined>();
    const options: ({ ifExists?: boolean } | undefined)[] = [];
    const p = new Persister(engine, (o?: { ifExists?: boolean }) => {
      options.push(o);
      return options.length === 1 ? first.promise : Promise.resolve(store);
    });
    const clearing = p.clearAll();
    await tick();
    engine.cache(config({ id: "B" }));
    await p.open("B");
    expect(options).toEqual([{ ifExists: true }]);
    expect(store.log).toEqual([]);
    engine.put("B", batch([0], [42]));
    const flushing = p.flush("B");
    await tick();
    expect(store.log).toEqual([]);
    first.resolve(undefined);
    await clearing;
    await tick();
    await flushing;
    expect(options).toEqual([{ ifExists: true }, undefined]);
    expect(store.log.map((c) => c.kind)).toEqual(["write"]);
    expect(writes(store)[0]?.plan.deletePages).toEqual(allPages);
    expectRecords(store.records("B"), engine, "B");
  });
  it("a store opening failure settles the clear and stops tracked and later caches without cleanup", async () => {
    const engine = new Engine();
    const { deferred } = await import("./persist-memory-store");
    const opening = deferred<never>();
    const stopped: unknown[] = [];
    const p = new Persister(engine, () => opening.promise, {
      onStopped: (e: unknown) => stopped.push(e),
    });
    const clearing = p.clearAll();
    await tick();
    engine.cache(config());
    await p.open("persist");
    opening.reject(new DOMException("blocked", "SecurityError"));
    await clearing;
    expect(stopped).toEqual([
      {
        cacheId: "persist",
        reason: "unavailable",
        error: { name: "SecurityError", message: "blocked" },
      },
    ]);
    engine.cache(config({ id: "later" }));
    await p.open("later");
    expect(stopped).toHaveLength(2);
    expect(stopped[1]).toEqual({ ...(stopped[0] as object), cacheId: "later" });
  });
  it("close requested during a barrier waits for the clear and held flush, then closes", async () => {
    const h = await opened();
    const gate = h.store.gate("clearAll");
    const clearing = clearAll(h);
    await tick();
    await gate.entered;
    h.engine.put("persist", batch([0]));
    const closing = tracked(h.persister.close());
    await tick();
    expect(closing.done).toBe(false);
    const write = h.store.gate("write");
    gate.release();
    await clearing;
    await tick();
    await write.entered;
    expect(closing.done).toBe(false);
    write.release();
    await closing.promise;
    expectRecords(h.store.records("persist"), h.engine);
    await expect(h.store.read("persist")).rejects.toMatchObject({
      name: "InvalidStateError",
    });
  });
});
