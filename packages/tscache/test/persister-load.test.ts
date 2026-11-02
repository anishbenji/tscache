import { describe, expect, it, vi } from "vitest";
import { Engine } from "../src/engine/engine";
import { UnknownCacheError } from "../src/errors";
import { Persister } from "../src/persist/persister";
import { fakeTime, harness, tick, writes } from "./persist-harness";
import { deferred } from "./persist-memory-store";
import {
  all,
  allPages,
  config,
  expectRecords,
  fixture,
  tracked,
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
  it("read rejection emits error details once and one strict cleanup", async () => {
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
    expect(writes(h.store).map((c) => c.plan)).toEqual([
      { deletePages: allPages, putPages: [], putCache: null, strict: true },
    ]);
    await h.persister.open("persist");
    expect(h.stopped).toHaveLength(1);
  });
  it("a gated read times out at 5000ms; a late result is ignored", async () => {
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
    expect(writes(h.store)).toHaveLength(1);
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
