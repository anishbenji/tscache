import { describe, expect, it } from "vitest";
import {
  clearAll,
  fakeTime,
  finish,
  opened,
  tick,
  writes,
} from "./persist-harness";
import {
  allPages,
  batch,
  config,
  expectRecords,
  fixture,
  tracked,
} from "./persist-test-helpers";

// Contract tests for slice (c), the quota stop (architecture §4.10.6
// "Failures", N47, N59): a `write` rejected with name 'QuotaExceededError'
// stops the cache at once with 'quota-exceeded', without a retry, and the
// Stopping rule's one cleanup write follows. Every other rejection is
// retried as before, and the clearAll barrier's final attempt is unchanged.

fakeTime();

const cleanupPlan = {
  deletePages: allPages,
  putPages: [],
  putCache: null,
  strict: true,
};

describe("a quota error stops the cache at once (§4.10.6, N47)", () => {
  it("a flush rejected with QuotaExceededError stops with 'quota-exceeded', no retry, one cleanup", async () => {
    const h = await opened();
    h.store.seed("persist", fixture());
    h.engine.put("persist", batch([0, 3]));
    h.store.fail("write", 1, "QuotaExceededError", "quota exceeded");
    const flushing = tracked(h.persister.flush());
    await tick();
    // At once: well before the retry delay (debounceMs) would have elapsed.
    expect(h.stopped).toEqual([
      {
        cacheId: "persist",
        reason: "quota-exceeded",
        error: { name: "QuotaExceededError", message: "quota exceeded" },
      },
    ]);
    await flushing.promise;
    await h.persister.durable("persist");
    expect(writes(h.store)).toHaveLength(2);
    expect(writes(h.store)[1]?.plan).toEqual(cleanupPlan);
    expect(h.store.records("persist")).toEqual({ cache: undefined, pages: [] });
    // No retry, and the persister never writes for the cache again.
    await tick(10000);
    expect(writes(h.store)).toHaveLength(2);
    h.engine.put("persist", batch([4]));
    await finish(h.persister.flush());
    await tick(10000);
    expect(writes(h.store)).toHaveLength(2);
    expect(h.stopped).toHaveLength(1);
  });

  it("a DOMException named QuotaExceededError, as IndexedDB rejects with, stops the cache too", async () => {
    const h = await opened();
    h.engine.put("persist", batch([0]));
    const gate = h.store.gate("write");
    const flushing = h.persister.flush();
    await tick();
    await gate.entered;
    gate.reject(
      new DOMException("The quota has been exceeded.", "QuotaExceededError"),
    );
    await tick();
    expect(h.stopped).toEqual([
      {
        cacheId: "persist",
        reason: "quota-exceeded",
        error: {
          name: "QuotaExceededError",
          message: "The quota has been exceeded.",
        },
      },
    ]);
    await flushing;
    await h.persister.durable("persist");
    expect(writes(h.store)).toHaveLength(2);
    expect(writes(h.store)[1]?.plan).toEqual(cleanupPlan);
  });

  it("a retry rejected with QuotaExceededError stops at once, before the job's deadline", async () => {
    const h = await opened();
    h.engine.put("persist", batch([0]));
    h.store.fail("write", 1, "UnknownError", "transient");
    const flushing = tracked(h.persister.flush());
    await tick();
    expect(writes(h.store)).toHaveLength(1);
    expect(h.stopped).toEqual([]);
    h.store.fail("write", 1, "QuotaExceededError", "quota exceeded");
    await tick(1000);
    expect(h.stopped).toEqual([
      {
        cacheId: "persist",
        reason: "quota-exceeded",
        error: { name: "QuotaExceededError", message: "quota exceeded" },
      },
    ]);
    await flushing.promise;
    await h.persister.durable("persist");
    expect(writes(h.store)).toHaveLength(3);
    expect(writes(h.store)[2]?.plan).toEqual(cleanupPlan);
    await tick(10000);
    expect(writes(h.store)).toHaveLength(3);
  });

  it("a removal waiting on the rejected job is released by the cleanup", async () => {
    const h = await opened();
    h.engine.put("persist", batch([0, 3]));
    await finish(h.persister.flush());
    h.store.log.length = 0;
    const gate = h.store.gate("write");
    h.engine.invalidate("persist", { start: 3, end: 3 });
    const durable = tracked(h.persister.durable("persist"));
    await tick();
    await gate.entered;
    gate.reject(
      Object.assign(new Error("full"), { name: "QuotaExceededError" }),
    );
    await tick();
    expect(h.stopped.map((e) => e.reason)).toEqual(["quota-exceeded"]);
    await durable.promise;
    expect(writes(h.store)).toHaveLength(2);
    expect(writes(h.store)[1]?.plan).toEqual(cleanupPlan);
    expect(h.store.records("persist")).toEqual({ cache: undefined, pages: [] });
  });

  it("only the cache whose write hit the quota stops; another cache's flush still lands", async () => {
    const h = await opened();
    h.engine.cache(config({ id: "other" }));
    await h.persister.open("other");
    h.engine.put("persist", batch([0]));
    h.engine.put("other", batch([0]));
    const gate = h.store.gate("write");
    const first = h.persister.flush("persist");
    const second = h.persister.flush("other");
    await tick();
    await gate.entered;
    gate.reject(
      Object.assign(new Error("full"), { name: "QuotaExceededError" }),
    );
    await tick();
    expect(h.stopped.map((e) => [e.cacheId, e.reason])).toEqual([
      ["persist", "quota-exceeded"],
    ]);
    await first;
    await second;
    await h.persister.durable("persist");
    expectRecords(h.store.records("other"), h.engine, "other");
    expect(h.store.records("persist")).toEqual({ cache: undefined, pages: [] });
  });

  it("a cleanup rejected with QuotaExceededError is ignored: no second stop, no retry", async () => {
    const h = await opened();
    h.store.seed("persist", fixture());
    h.engine.put("persist", batch([0]));
    h.store.fail("write", 2, "QuotaExceededError", "quota exceeded");
    const flushing = h.persister.flush();
    await tick();
    expect(h.stopped.map((e) => e.reason)).toEqual(["quota-exceeded"]);
    await flushing;
    await h.persister.durable("persist");
    expect(writes(h.store)).toHaveLength(2);
    expect(writes(h.store)[1]?.plan).toEqual(cleanupPlan);
    // The cleanup failed: the records stay (§4.10.1), and nothing retries.
    expect(h.store.records("persist")).toEqual(fixture());
    await tick(10000);
    expect(writes(h.store)).toHaveLength(2);
    expect(h.stopped).toHaveLength(1);
  });

  it("a cleanup after another stop that hits the quota is ignored too", async () => {
    const h = await opened();
    h.engine.put("persist", batch([0]));
    h.store.fail("write", Infinity, "UnknownError", "disk refused");
    const flushing = h.persister.flush();
    await tick(4999);
    expect(h.stopped).toEqual([]);
    h.store.fail("write", 1, "QuotaExceededError", "quota exceeded");
    await tick(1);
    await flushing;
    await h.persister.durable("persist");
    expect(h.stopped).toEqual([
      {
        cacheId: "persist",
        reason: "error",
        error: { name: "UnknownError", message: "disk refused" },
      },
    ]);
    expect(writes(h.store).at(-1)?.plan).toEqual(cleanupPlan);
    const count = writes(h.store).length;
    await tick(10000);
    expect(writes(h.store)).toHaveLength(count);
  });
});

describe("other rejections and the clearAll barrier keep their rules", () => {
  it.each([
    ["UnknownError", "quota exceeded"],
    ["QuotaExceeded", "quota"],
    ["quotaexceedederror", "quota"],
    ["DataError", "QuotaExceededError"],
  ])(
    "a write rejected with name %s (message %s) is retried after debounceMs",
    async (name, message) => {
      const h = await opened();
      h.engine.put("persist", batch([0]));
      h.store.fail("write", 1, name, message);
      const flushing = tracked(h.persister.flush());
      await tick();
      expect(writes(h.store)).toHaveLength(1);
      expect(flushing.done).toBe(false);
      await tick(999);
      expect(writes(h.store)).toHaveLength(1);
      await tick(1);
      await flushing.promise;
      expect(writes(h.store)).toHaveLength(2);
      expect(h.stopped).toEqual([]);
      expectRecords(h.store.records("persist"), h.engine);
    },
  );

  it("a clearAll whose store call is rejected with QuotaExceededError retries; nothing stops", async () => {
    const h = await opened();
    h.engine.put("persist", batch([0]));
    await finish(h.persister.flush());
    h.store.fail("clearAll", 1, "QuotaExceededError", "quota exceeded");
    const clearing = tracked(clearAll(h));
    await tick();
    expect(h.store.log.filter((c) => c.kind === "clearAll")).toHaveLength(1);
    expect(clearing.done).toBe(false);
    await tick(1000);
    await clearing.promise;
    expect(h.store.log.filter((c) => c.kind === "clearAll")).toHaveLength(2);
    expect(h.stopped).toEqual([]);
    expect(h.store.records("persist")).toEqual({ cache: undefined, pages: [] });
  });

  it("the flush attempt running at a clearAll call stays final on a quota rejection: no stop, no cleanup", async () => {
    const h = await opened();
    h.engine.put("persist", batch([0]));
    const gate = h.store.gate("write");
    const flush = h.persister.flush();
    await tick();
    await gate.entered;
    const clearing = tracked(clearAll(h));
    await tick();
    gate.reject(
      Object.assign(new Error("full"), { name: "QuotaExceededError" }),
    );
    await flush;
    await tick();
    await clearing.promise;
    expect(h.stopped).toEqual([]);
    expect(writes(h.store)).toHaveLength(1);
    await tick(10000);
    expect(writes(h.store)).toHaveLength(1);
    // The cache goes on persisting after the barrier.
    h.engine.put("persist", batch([3]));
    await finish(h.persister.flush());
    expect(writes(h.store)).toHaveLength(2);
    expectRecords(h.store.records("persist"), h.engine);
  });
});
