import { describe, expect, it, vi } from "vitest";
import { Engine } from "../src/engine/engine";
import { UnknownCacheError } from "../src/errors";
import { HostedPersistence, type LazyPersist } from "../src/persist/hosted";
import * as lazy from "../src/persist/lazy";
import { Persister } from "../src/persist/persister";
import { fakeTime, finish, harness, tick, writes } from "./persist-harness";
import { deferred, MemoryStore } from "./persist-memory-store";
import {
  all,
  allPages,
  batch,
  config,
  expectRecords,
  fixture,
  tracked,
  type Unreadable,
  unreadable,
} from "./persist-test-helpers";

fakeTime();
describe("Persister.open (§4.10.6 Open, N46, N59)", () => {
  it("is lazy, non-persisted caches touch no store, unknown ids reject", async () => {
    const h = harness();
    expect(h.openStore).not.toHaveBeenCalled();
    h.engine.cache(config({ persist: false }));
    await h.persister.open("persist");
    expect(h.openStore).not.toHaveBeenCalled();
    expect(h.store.log).toEqual([]);
    await expect(h.persister.open("missing")).rejects.toBeInstanceOf(
      UnknownCacheError,
    );
  });
  it("concurrent opens share one opening and one read per cache, all wait for restore", async () => {
    const h = harness();
    h.engine.cache(config());
    h.engine.cache(config({ id: "B" }));
    h.store.seed("persist", fixture({}, [0]));
    const gate = h.store.gate("read");
    const first = tracked(h.persister.open("persist"));
    const second = tracked(h.persister.open("persist"));
    await tick();
    await gate.entered;
    expect(first.done).toBe(false);
    expect(second.done).toBe(false);
    await h.persister.open("B");
    gate.release();
    await Promise.all([first.promise, second.promise]);
    await h.persister.open("persist");
    expect(h.engine.get("persist", { start: 0, end: 0 }).misses).toEqual([]);
    expect(h.openStore).toHaveBeenCalledTimes(1);
    expect(h.openStore).not.toHaveBeenCalledWith(
      expect.objectContaining({ ifExists: true }),
    );
    expect(
      h.store.log.filter((c) => c.kind === "read" && c.cacheId === "persist"),
    ).toHaveLength(1);
  });
  it.each(["reject", "undefined"])(
    "openStore %s stops this and future caches as unavailable",
    async (outcome) => {
      const engine = new Engine();
      engine.cache(config());
      engine.cache(config({ id: "B" }));
      const error = new DOMException("access denied", "SecurityError");
      const openStore = vi.fn(
        outcome === "reject"
          ? async () => {
              throw error;
            }
          : async () => undefined,
      );
      const stopped: unknown[] = [];
      const p = new Persister(engine, openStore, {
        onStopped: (e: unknown) => stopped.push(e),
      });
      await p.open("persist");
      await p.open("B");
      await p.open("persist");
      expect(openStore).toHaveBeenCalledTimes(1);
      expect(stopped).toEqual(
        ["persist", "B"].map((cacheId) =>
          outcome === "reject"
            ? {
                cacheId,
                reason: "unavailable",
                error: { name: "SecurityError", message: "access denied" },
              }
            : { cacheId, reason: "unavailable" },
        ),
      );
    },
  );
  it("read rejection emits error details once and writes no cleanup", async () => {
    const h = harness();
    h.engine.cache(config());
    h.store.seed("persist", fixture());
    h.store.fail("read", 1, "UnknownError", "read failed");
    await h.persister.open("persist");
    await tick();
    await h.persister.durable("persist");
    expect(h.stopped).toEqual([
      {
        cacheId: "persist",
        reason: "error",
        error: { name: "UnknownError", message: "read failed" },
      },
    ]);
    expect(writes(h.store)).toEqual([]);
    await h.persister.open("persist");
    expect(h.stopped).toHaveLength(1);
  });
  it("a gated read times out at 5000ms without cleanup and ignores a late result", async () => {
    const h = harness();
    h.engine.cache(config());
    h.store.seed("persist", fixture());
    const gate = h.store.gate("read");
    const opening = tracked(h.persister.open("persist"));
    await tick();
    await gate.entered;
    await tick(4999);
    expect(opening.done).toBe(false);
    await tick(1);
    await opening.promise;
    expect(h.stopped).toEqual([{ cacheId: "persist", reason: "unavailable" }]);
    gate.release();
    await tick();
    expect(h.engine.get("persist", all).timestamps).toEqual(new Float64Array());
    expect(writes(h.store)).toHaveLength(0);
  });
  it("records survive a read timeout and a later session loads them", async () => {
    const h = harness();
    h.engine.cache(config());
    const seeded = fixture();
    h.store.seed("persist", seeded);
    const gate = h.store.gate("read");
    const opening = h.persister.open("persist");
    await tick();
    await gate.entered;
    await tick(5000);
    await opening;
    gate.release();
    await tick();
    await h.persister.durable("persist");
    expect(h.store.records("persist")).toEqual(seeded);
    const next = harness({}, h.store);
    next.engine.cache(config());
    await next.persister.open("persist");
    expectRecords(seeded, next.engine);
  });
  it("records survive a read rejection and a later session loads them", async () => {
    const h = harness();
    h.engine.cache(config());
    const seeded = fixture();
    h.store.seed("persist", seeded);
    h.store.fail("read", 1, "UnknownError", "read failed");
    await h.persister.open("persist");
    await tick();
    await h.persister.durable("persist");
    expect(h.store.records("persist")).toEqual(seeded);
    const next = harness({}, h.store);
    next.engine.cache(config());
    await next.persister.open("persist");
    expectRecords(seeded, next.engine);
  });
  it("records survive a store opening timeout and a later session loads them", async () => {
    const h = harness();
    h.engine.cache(config());
    const seeded = fixture();
    h.store.seed("persist", seeded);
    const gate = deferred<typeof h.store>();
    h.openStore.mockReturnValueOnce(gate.promise);
    const opening = tracked(h.persister.open("persist"));
    await tick(4999);
    expect(h.openStore).toHaveBeenCalledTimes(1);
    expect(opening.done).toBe(false);
    await tick(1);
    await opening.promise;
    expect(h.stopped).toEqual([{ cacheId: "persist", reason: "unavailable" }]);
    gate.resolve(h.store);
    await tick();
    expect(h.store.records("persist")).toEqual(seeded);
    const next = harness({}, h.store);
    next.engine.cache(config());
    await next.persister.open("persist");
    expectRecords(seeded, next.engine);
  });
  it("store opening and read share the same load deadline", async () => {
    const h = harness();
    h.engine.cache(config());
    const gate = deferred<typeof h.store>();
    const stopped: unknown[] = [];
    const p = new Persister(h.engine, () => gate.promise, {
      onStopped: (e: unknown) => stopped.push(e),
    });
    const opening = tracked(p.open("persist"));
    await tick(4000);
    const read = h.store.gate("read");
    gate.resolve(h.store);
    await tick();
    await read.entered;
    await tick(999);
    expect(opening.done).toBe(false);
    await tick(1);
    await opening.promise;
    expect(stopped).toEqual([{ cacheId: "persist", reason: "unavailable" }]);
    read.release();
    await tick();
  });
  it("restore rewrite is due now and writes canonical state without reading again", async () => {
    const h = harness();
    h.engine.cache(config({ version: "new" }));
    h.store.seed("persist", fixture({ version: "old" }));
    await h.persister.open("persist");
    await tick();
    expect(writes(h.store)).toHaveLength(1);
    expect(writes(h.store)[0]?.plan.deletePages).toEqual(allPages);
    expectRecords(h.store.records("persist"), h.engine);
    expect(h.store.log.filter((c) => c.kind === "read")).toHaveLength(1);
  });
  it("a retained higher creation watermark is written at the next debounced flush, cache only", async () => {
    const h = harness();
    h.engine.cache(config({ finalizedUntil: 30 }));
    h.store.seed("persist", fixture({ finalizedUntil: 20 }, [0]));
    await h.persister.open("persist");
    await tick(999);
    expect(writes(h.store)).toEqual([]);
    await tick(1);
    expect(writes(h.store)).toHaveLength(1);
    expect(writes(h.store)[0]?.plan).toMatchObject({
      deletePages: [],
      putPages: [],
      putCache: { finalizedUntil: 30 },
      strict: false,
    });
    expectRecords(h.store.records("persist"), h.engine);
  });
});

// Security lane run 4, S4.1 (and pre-review 3): an opener rejecting with a
// value whose name and message cannot be read as usual still fails the
// opening at once, with no unhandled rejection (Vitest fails the run on one).
describe("an opener rejecting with an unreadable value (S4.1)", () => {
  const kinds = ["null prototype", "revoked proxy"] as const;
  const error = { name: "Error", message: "Error" };
  function failing(kind: Unreadable) {
    const engine = new Engine();
    engine.cache(config());
    const stopped: unknown[] = [];
    const openStore = vi.fn(() => Promise.reject(unreadable(kind)));
    const persister = new Persister(engine, openStore, {
      onStopped: (e: unknown) => stopped.push(e),
    });
    return { engine, persister, openStore, stopped };
  }

  it.each(kinds)(
    "clearAll fails at once with 'unavailable' (%s)",
    async (kind) => {
      const h = failing(kind);
      const clearing = tracked(h.persister.clearAll());
      await tick();
      expect(clearing.done).toBe(true);
      expect(h.openStore.mock.calls).toEqual([[{ ifExists: true }]]);
      await h.persister.open("persist");
      expect(h.stopped).toEqual([
        { cacheId: "persist", reason: "unavailable", error },
      ]);
    },
  );

  it.each(kinds)(
    "open stops with 'unavailable' without waiting for its deadline (%s)",
    async (kind) => {
      const h = failing(kind);
      const opening = tracked(h.persister.open("persist"));
      await tick();
      expect(opening.done).toBe(true);
      expect(h.stopped).toEqual([
        { cacheId: "persist", reason: "unavailable", error },
      ]);
    },
  );
});

const invalidated = { start: 0, end: 0 };
const emptyRecords = { cache: undefined, pages: [] };

async function expectDeferredCleanup(
  store: MemoryStore,
  invalidate: () => Promise<void>,
): Promise<void> {
  const write = store.gate("write");
  const acknowledged = invalidate().then(() => store.records("persist"));
  const durable = tracked(acknowledged.then(() => undefined));
  await tick();
  const completedWhileWriteHeld = durable.done;
  write.release();
  await finish(durable.promise);

  const next = harness({}, store);
  next.engine.cache(config());
  await next.persister.open("persist");
  const { misses, timestamps } = next.engine.get("persist", invalidated);
  expect({
    completedWhileWriteHeld,
    recordsAtAcknowledgment: await acknowledged,
    misses,
    timestamps,
  }).toEqual({
    completedWhileWriteHeld: false,
    recordsAtAcknowledgment: emptyRecords,
    misses: [{ range: invalidated, reason: "uncached" }],
    timestamps: new Float64Array(),
  });
  expect(writes(store)).toMatchObject([
    { cacheId: "persist", settled: true, plan: { strict: true } },
  ]);
}

describe("deferred cleanup after a load stop (user decision 113 A, N58)", () => {
  it("makes an invalidate durable after a read timeout", async () => {
    const h = harness();
    h.engine.cache(config());
    h.store.seed("persist", fixture({}, [0, 4]));
    const read = h.store.gate("read");
    const opening = h.persister.open("persist");
    await read.entered;
    await tick(5000);
    await opening;
    expect(h.stopped).toEqual([{ cacheId: "persist", reason: "unavailable" }]);
    read.release();
    await tick();

    await expectDeferredCleanup(h.store, () => {
      h.engine.invalidate("persist", invalidated);
      return h.persister.durable("persist");
    });
  });

  it("makes an invalidate durable after a rejected read", async () => {
    const h = harness();
    h.engine.cache(config());
    h.store.seed("persist", fixture({}, [0, 4]));
    h.store.fail("read");
    await h.persister.open("persist");
    expect(h.stopped).toHaveLength(1);
    expect(h.stopped[0]?.reason).toBe("error");

    await expectDeferredCleanup(h.store, () => {
      h.engine.invalidate("persist", invalidated);
      return h.persister.durable("persist");
    });
  });

  it.each(["rejection", "timeout"])(
    "makes an invalidate durable after a store-open %s",
    async (failure) => {
      const h = harness();
      h.engine.cache(config());
      h.store.seed("persist", fixture({}, [0, 4]));
      const gate = deferred<MemoryStore>();
      h.openStore.mockReturnValueOnce(gate.promise);
      const opening = h.persister.open("persist");
      if (failure === "rejection") {
        gate.reject(new DOMException("open failed", "UnknownError"));
      } else {
        await tick(5000);
      }
      await opening;
      expect(h.stopped).toHaveLength(1);
      expect(h.stopped[0]?.reason).toBe("unavailable");

      await expectDeferredCleanup(h.store, () => {
        h.engine.invalidate("persist", invalidated);
        const durable = h.persister.durable("persist");
        if (failure === "timeout") gate.resolve(h.store);
        return durable;
      });
    },
  );

  it.each(["rejection", "timeout"])(
    "makes an invalidate durable after a chunk-import %s",
    async (failure) => {
      const engine = new Engine();
      const store = new MemoryStore();
      const onStopped = vi.fn();
      engine.cache(config());
      store.seed("persist", fixture({}, [0, 4]));
      const chunk = deferred<LazyPersist>();
      const persistence = new HostedPersistence(
        engine,
        () => chunk.promise,
        async () => store,
        { onStopped },
      );
      const opening = persistence.open("persist");
      if (failure === "rejection") {
        chunk.reject(new TypeError("chunk failed"));
      } else {
        await tick(5000);
      }
      await opening;
      expect(onStopped).toHaveBeenCalledTimes(1);
      expect(onStopped).toHaveBeenCalledWith(
        expect.objectContaining({ cacheId: "persist", reason: "unavailable" }),
      );

      await expectDeferredCleanup(store, async () => {
        const removal = persistence.durably("persist", () =>
          engine.invalidate("persist", invalidated),
        );
        if (failure === "timeout") chunk.resolve(lazy);
        await removal;
      });
    },
  );

  it("keeps every record after a load stop with no later removal", async () => {
    const h = harness();
    h.engine.cache(config());
    const seeded = fixture();
    h.store.seed("persist", seeded);
    h.store.fail("read");
    await h.persister.open("persist");
    expect(h.stopped[0]?.reason).toBe("error");
    h.engine.put("persist", batch([10]));
    await tick(5000);
    await h.persister.durable("persist");

    expect(writes(h.store)).toEqual([]);
    expect(h.store.records("persist")).toEqual(seeded);
    const next = harness({}, h.store);
    next.engine.cache(config());
    await next.persister.open("persist");
    expectRecords(seeded, next.engine);
  });

  it("cleans up a stopped cache once while a running cache's removal still writes", async () => {
    const h = harness();
    h.engine.cache(config());
    h.engine.cache(config({ id: "running" }));
    h.store.seed("persist", fixture({}, [0, 4]));
    h.store.seed("running", fixture({ id: "running" }, [0, 4]));
    h.store.fail("read");
    await h.persister.open("persist");
    await h.persister.open("running");

    const cleanup = h.store.gate("write");
    h.engine.invalidate("persist", invalidated);
    const first = h.persister.durable("persist");
    await tick();
    h.engine.invalidate("persist", { start: 4, end: 4 });
    const second = h.persister.durable("persist");
    h.engine.invalidate("running", invalidated);
    const running = h.persister.durable("running");
    cleanup.release();
    await finish(Promise.all([first, second, running]).then(() => undefined));

    expect(writes(h.store)).toMatchObject([
      {
        cacheId: "persist",
        settled: true,
        plan: {
          deletePages: allPages,
          putPages: [],
          putCache: null,
          strict: true,
        },
      },
      { cacheId: "running", settled: true, plan: { strict: true } },
    ]);
    expect(h.store.records("persist")).toEqual(emptyRecords);
    expectRecords(h.store.records("running"), h.engine, "running");
  });
});
