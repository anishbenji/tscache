import { describe, expect, it, vi } from "vitest";
import { durably } from "../src/persist/persister";
import {
  clearAll,
  fakeTime,
  finish,
  harness,
  opened,
  tick,
  writes,
} from "./persist-harness";
import { deferred, type MemoryStore } from "./persist-memory-store";
import { batch, config, fixture, tracked } from "./persist-test-helpers";

// Implementer tests (user decision 113 A, §4.10.6 Failures): a clearAll is
// the first removal of a cache stopped by its load. Its clear job deletes
// every record, so it stands in for the deferred cleanup: no cleanup job
// runs ahead of the clear, and the cache's durable() calls settle with it.

fakeTime();

describe("a clearAll after a load stop (user decision 113 A)", () => {
  it("runs no cleanup of its own and settles durable() with the clear", async () => {
    const h = harness();
    h.engine.cache(config());
    h.store.seed("persist", fixture({}, [0, 4]));
    h.store.fail("read");
    await h.persister.open("persist");
    expect(h.stopped[0]?.reason).toBe("error");

    const gate = h.store.gate("clearAll");
    const clearing = clearAll(h);
    const durable = tracked(h.persister.durable("persist"));
    await tick();
    await gate.entered;
    expect(durable.done).toBe(false);
    gate.release();
    await finish(
      Promise.all([clearing, durable.promise]).then(() => undefined),
    );

    expect(writes(h.store)).toEqual([]);
    expect(h.store.records("persist")).toEqual({ cache: undefined, pages: [] });
  });

  it("settles durable() when the clear fails, the records staying", async () => {
    const h = harness();
    h.engine.cache(config());
    const seeded = fixture({}, [0, 4]);
    h.store.seed("persist", seeded);
    h.store.fail("read");
    await h.persister.open("persist");

    h.store.fail("clearAll", Infinity);
    const clearing = clearAll(h);
    const durable = tracked(h.persister.durable("persist"));
    await tick();
    expect(durable.done).toBe(false);
    await tick(5000);
    await finish(
      Promise.all([clearing, durable.promise]).then(() => undefined),
    );

    expect(writes(h.store)).toEqual([]);
    expect(h.store.records("persist")).toEqual(seeded);
  });

  it("runs a deferred cleanup queued before the call ahead of the clear", async () => {
    const h = harness();
    h.engine.cache(config());
    h.engine.cache(config({ id: "running" }));
    h.store.seed("persist", fixture({}, [0, 4]));
    h.store.seed("running", fixture({ id: "running" }, [0, 4]));
    h.store.fail("read");
    await h.persister.open("persist");
    await h.persister.open("running");

    const flush = h.store.gate("write");
    h.engine.invalidate("running", { start: 0, end: 0 });
    await tick();
    await flush.entered;
    h.engine.invalidate("persist", { start: 0, end: 0 });
    const durable = tracked(h.persister.durable("persist"));
    await tick();
    const clearing = clearAll(h);
    flush.release();
    await finish(
      Promise.all([clearing, durable.promise]).then(() => undefined),
    );

    const order = h.store.log
      .filter((call) => call.kind === "write" || call.kind === "clearAll")
      .map((call) => (call.kind === "write" ? call.cacheId : call.kind));
    expect(order).toEqual(["running", "persist", "clearAll"]);
    expect(h.store.records("persist")).toEqual({ cache: undefined, pages: [] });
  });
});

describe("a cleanup queued earlier in the same turn (Codex gate round 1, R1-1)", () => {
  it("runs ahead of a clearAll that fails, deleting the removed records", async () => {
    const h = harness();
    h.engine.cache(config());
    h.store.seed("persist", fixture({}, [0, 4]));
    h.store.fail("read");
    await h.persister.open("persist");

    h.engine.invalidate("persist", { start: 0, end: 0 });
    const durable = tracked(h.persister.durable("persist"));
    h.store.fail("clearAll", Infinity);
    const clearing = clearAll(h);
    await tick();
    await tick(5000);
    await finish(
      Promise.all([clearing, durable.promise]).then(() => undefined),
    );

    expect(writes(h.store)).toMatchObject([
      { cacheId: "persist", settled: true, plan: { strict: true } },
    ]);
    expect(h.store.records("persist")).toEqual({ cache: undefined, pages: [] });
  });
});

describe("an op whose removal comes after an await (security lane 2, S2.1)", () => {
  it("answers through durably once the deferred cleanup settled", async () => {
    const h = harness();
    h.engine.cache(config());
    h.store.seed("persist", fixture({}, [0, 4]));
    h.store.fail("read");
    await h.persister.open("persist");
    const cleanup = h.store.gate("write");
    const answer = tracked(
      Promise.resolve(
        durably(h.persister, "persist", async () => {
          await Promise.resolve();
          h.engine.invalidate("persist", { start: 0, end: 0 });
        }),
      ).then(() => undefined),
    );
    await tick();
    await cleanup.entered;
    await tick();
    expect(answer.done).toBe(false);
    cleanup.release();
    await finish(answer.promise);
    expect(h.store.records("persist")).toEqual({ cache: undefined, pages: [] });
  });
});

// Codex gate round 2 (R2-1) and the class map of step 132's review file: a
// failed clearAll was every tracked cache's cleanup, so no deferred cleanup
// may run for any of them afterwards (§4.10.6 clearAll, Failure; property
// (n); checklist §12).
describe("the deferred cleanup after a failed clearAll (Codex gate round 2, R2-1)", () => {
  it("is disarmed for a cache the clear's shared store opening stopped", async () => {
    const h = harness();
    h.engine.cache(config());
    const seeded = fixture({}, [0, 4]);
    h.store.seed("persist", seeded);
    const opening = deferred<MemoryStore>();
    h.openStore.mockReturnValueOnce(opening.promise);
    const loading = h.persister.open("persist");
    await tick();
    const clearing = clearAll(h);
    await tick();
    opening.reject(new DOMException("open failed", "UnknownError"));
    await finish(Promise.all([loading, clearing]).then(() => undefined));
    expect(h.stopped).toMatchObject([
      { cacheId: "persist", reason: "unavailable" },
    ]);

    h.engine.invalidate("persist", { start: 0, end: 0 });
    const durable = tracked(h.persister.durable("persist"));
    await tick(5000);

    expect(durable.done).toBe(true);
    expect(h.openStore).toHaveBeenCalledTimes(1);
    expect(writes(h.store)).toEqual([]);
    expect(h.store.records("persist")).toEqual(seeded);
  });

  it("is disarmed when store.clearAll() fails until the deadline", async () => {
    const h = harness();
    h.engine.cache(config());
    const seeded = fixture({}, [0, 4]);
    h.store.seed("persist", seeded);
    h.store.fail("read");
    await h.persister.open("persist");
    h.store.fail("clearAll", Infinity);
    const clearing = clearAll(h);
    await tick();
    await tick(5000);
    await clearing;

    const before = h.store.log.length;
    h.engine.invalidate("persist", { start: 0, end: 0 });
    const durable = tracked(h.persister.durable("persist"));
    await tick(5000);

    expect(durable.done).toBe(true);
    expect(h.store.log.slice(before)).toEqual([]);
    expect(h.store.records("persist")).toEqual(seeded);
  });

  it("is disarmed when the clear's own store opening fails after an earlier one did", async () => {
    const h = harness();
    h.engine.cache(config());
    const seeded = fixture({}, [0, 4]);
    h.store.seed("persist", seeded);
    const failed = new DOMException("open failed", "UnknownError");
    h.openStore.mockRejectedValueOnce(failed);
    h.openStore.mockRejectedValueOnce(failed);
    await h.persister.open("persist");
    await finish(clearAll(h));
    expect(h.openStore).toHaveBeenCalledTimes(2);

    h.engine.invalidate("persist", { start: 0, end: 0 });
    const durable = tracked(h.persister.durable("persist"));
    await tick(5000);

    expect(durable.done).toBe(true);
    expect(h.openStore).toHaveBeenCalledTimes(2);
    expect(writes(h.store)).toEqual([]);
    expect(h.store.records("persist")).toEqual(seeded);
  });

  it("is never armed for a cache opened after the failed clear", async () => {
    const h = await opened();
    h.store.seed("later", fixture({ id: "later" }, [0, 4]));
    h.store.fail("clearAll", Infinity);
    const clearing = clearAll(h);
    await tick();
    await tick(5000);
    await clearing;
    h.engine.cache(config({ id: "later" }));
    await h.persister.open("later");

    const before = h.store.log.length;
    h.engine.invalidate("later", { start: 0, end: 0 });
    const durable = tracked(h.persister.durable("later"));
    await tick(5000);

    expect(durable.done).toBe(true);
    expect(h.store.log.slice(before)).toEqual([]);
    expect(h.store.records("later")).toEqual(fixture({ id: "later" }, [0, 4]));
  });
});

// The class map's other cells (§4.10.6 Open and Failures, checklist §12).
describe("the deferred cleanup across the failure paths (step 132 class map)", () => {
  it("is armed for a cache opened after a failed store opening, and its first removal deletes", async () => {
    const h = harness();
    h.engine.cache(config());
    h.openStore.mockRejectedValueOnce(
      new DOMException("open failed", "UnknownError"),
    );
    await h.persister.open("persist");
    h.engine.cache(config({ id: "later" }));
    h.store.seed("later", fixture({ id: "later" }, [0, 4]));
    await h.persister.open("later");
    expect(h.stopped).toMatchObject([
      { cacheId: "persist", reason: "unavailable" },
      { cacheId: "later", reason: "unavailable" },
    ]);
    expect(h.store.log).toEqual([]);

    h.engine.invalidate("later", { start: 0, end: 0 });
    const durable = tracked(h.persister.durable("later"));
    await finish(durable.promise);

    expect(h.openStore.mock.calls.at(-1)).toEqual([{ ifExists: true }]);
    expect(writes(h.store)).toMatchObject([
      { cacheId: "later", settled: true, plan: { strict: true } },
    ]);
    expect(h.store.records("later")).toEqual({ cache: undefined, pages: [] });
  });

  it("is armed for a cache whose load a removal abandoned before the opening failed", async () => {
    const h = harness();
    h.engine.cache(config());
    h.store.seed("persist", fixture({}, [0, 4]));
    const opening = deferred<MemoryStore>();
    h.openStore.mockReturnValueOnce(opening.promise);
    const loading = h.persister.open("persist");
    await tick();
    h.engine.invalidate("persist", { start: 0, end: 0 });
    opening.reject(new DOMException("open failed", "UnknownError"));
    await finish(loading);
    expect(h.stopped).toMatchObject([
      { cacheId: "persist", reason: "unavailable" },
    ]);

    h.engine.invalidate("persist", { start: 1, end: 1 });
    const durable = tracked(h.persister.durable("persist"));
    await finish(durable.promise);

    expect(writes(h.store)).toMatchObject([
      { cacheId: "persist", settled: true, plan: { strict: true } },
    ]);
    expect(h.store.records("persist")).toEqual({ cache: undefined, pages: [] });
  });

  it("is spent by a clearAll that succeeded: a later removal writes nothing", async () => {
    const h = harness();
    h.engine.cache(config());
    h.store.seed("persist", fixture({}, [0, 4]));
    h.store.fail("read");
    await h.persister.open("persist");
    await finish(clearAll(h));
    h.store.seed("persist", fixture({}, [0, 4]));

    const before = h.store.log.length;
    h.engine.invalidate("persist", { start: 0, end: 0 });
    const durable = tracked(h.persister.durable("persist"));
    await tick(5000);

    expect(durable.done).toBe(true);
    expect(h.store.log.slice(before)).toEqual([]);
  });
});

// Codex gate round 4, R4-4: the stop's deferred cleanup is armed before
// `onStopped` is called, so a removal the callback makes at once waits for it.
describe("a removal made by onStopped itself (Codex gate round 4, R4-4)", () => {
  it("waits for the deferred cleanup, and a later removal writes nothing", async () => {
    let removal: ReturnType<typeof tracked> | undefined;
    const h = harness({
      onStopped: () => {
        removal = tracked(
          Promise.resolve(
            durably(h.persister, "persist", () =>
              h.engine.invalidate("persist", { start: 0, end: 0 }),
            ),
          ).then(() => undefined),
        );
      },
    });
    h.engine.cache(config());
    h.store.seed("persist", fixture({}, [0, 4]));
    h.store.fail("read");
    const cleanup = h.store.gate("write");
    await h.persister.open("persist");
    expect(h.stopped[0]?.reason).toBe("error");
    await tick();
    expect(removal?.done).toBe(false);
    expect(writes(h.store)).toHaveLength(1);
    await cleanup.entered;
    await tick();
    expect(removal?.done).toBe(false);
    cleanup.release();
    await finish((removal as NonNullable<typeof removal>).promise);
    expect(h.store.records("persist")).toEqual({ cache: undefined, pages: [] });

    await finish(
      Promise.resolve(
        durably(h.persister, "persist", () =>
          h.engine.invalidate("persist", { start: 0, end: 0 }),
        ),
      ).then(() => undefined),
    );
    expect(writes(h.store)).toHaveLength(1);
  });
});

// Codex gate round 5, R5-1: a cache stopped by a failed store opening while a
// clearAll is pending. The clear is its deletion, so a removal it recorded
// before the stop answers with the clear job, not at the stop (§4.10.6 (l),
// Success; N58). Orders G (the gate's) and S (the check's shorter one), each
// with the clear's own opening held, resolving and rejecting.
describe("a removal pending when a clearAll's cache stops (Codex gate round 5, R5-1)", () => {
  type Opening = {
    ifExists: boolean;
    gate: ReturnType<typeof deferred<MemoryStore | undefined>>;
  };
  function gatedOpenings(h: ReturnType<typeof harness>): Opening[] {
    const openings: Opening[] = [];
    h.openStore.mockImplementation((options?: { ifExists?: boolean }) => {
      const gate = deferred<MemoryStore | undefined>();
      openings.push({ ifExists: options?.ifExists === true, gate });
      return gate.promise;
    });
    return openings;
  }
  /** A call's answer and the fake time it came at. */
  function answered(promise: unknown): { done: boolean; at: number } {
    const result = { done: false, at: Number.NaN };
    void Promise.resolve(promise).then(() => {
      result.done = true;
      result.at = now();
    });
    return result;
  }
  /** The fake clock's time. */
  const now = (): number => vi.getMockedSystemTime()?.getTime() ?? 0;
  const failed = (): DOMException =>
    new DOMException("open failed", "UnknownError");

  /** Settles the clear's own opening as `outcome`, then checks the answers. */
  async function settle(
    h: ReturnType<typeof harness>,
    clearOpening: Opening | undefined,
    outcome: "hold" | "resolve" | "reject",
    clearing: { done: boolean },
    clearAt: number,
    removals: { done: boolean; at: number }[],
  ): Promise<void> {
    expect(clearOpening?.ifExists).toBe(true);
    expect(clearing.done).toBe(false);
    for (const removal of removals) expect(removal.done).toBe(false);
    if (outcome === "hold") {
      await tick(clearAt + 5000 - now() - 1);
      expect(clearing.done).toBe(false);
      for (const removal of removals) expect(removal.done).toBe(false);
      await tick(1);
    } else if (outcome === "resolve") {
      clearOpening?.gate.resolve(h.store);
      await tick();
    } else {
      clearOpening?.gate.reject(failed());
      await tick();
    }
    expect(clearing.done).toBe(true);
    for (const removal of removals) {
      expect(removal.done).toBe(true);
      expect(removal.at).toBeLessThanOrEqual(clearAt + 5000);
    }
    expect(h.store.records("persist").pages).toHaveLength(
      outcome === "resolve" ? 0 : 2,
    );
  }

  for (const outcome of ["hold", "resolve", "reject"] as const) {
    it(`order G: an invalidate during the second clear's barrier, the clear's opening ${outcome}`, async () => {
      const h = harness();
      const openings = gatedOpenings(h);
      h.engine.clearAll();
      const first = answered(h.persister.clearAll());
      h.engine.cache(config());
      const loading = answered(h.persister.open("persist"));
      await tick();
      openings[0]?.gate.resolve(undefined); // no database
      await tick();
      expect(first.done && loading.done).toBe(true);
      h.engine.put("persist", batch([0, 1, 2, 3, 4, 5]));
      // Another writer creates the database meanwhile.
      h.store.seed("persist", fixture({}, [0, 4]));
      await tick(1000); // the flush starts and opens the store
      expect(openings.map((o) => o.ifExists)).toEqual([true, false]);

      const clearAt = now();
      const clearing = answered(clearAll(h));
      await tick(10);
      h.engine.put("persist", batch([0, 1, 2, 3]));
      const removal = answered(
        durably(h.persister, "persist", () =>
          h.engine.invalidate("persist", { start: 0, end: 1 }),
        ),
      );
      await tick(10);
      openings[1]?.gate.reject(failed());
      await tick();
      expect(h.stopped).toMatchObject([
        { cacheId: "persist", reason: "unavailable" },
      ]);

      await settle(h, openings[2], outcome, clearing, clearAt, [removal]);
    });

    it(`order S: removals before and during the barrier, the clear's opening ${outcome}`, async () => {
      const h = harness();
      const openings = gatedOpenings(h);
      h.store.seed("persist", fixture({}, [0, 4]));
      h.engine.cache(config());
      answered(h.persister.open("persist"));
      await tick();
      const before = answered(
        durably(h.persister, "persist", () => h.engine.clear("persist")),
      );
      await tick(10);
      const clearAt = now();
      const clearing = answered(clearAll(h));
      await tick(10);
      h.engine.put("persist", batch([0, 1, 2, 3]));
      const during = answered(
        durably(h.persister, "persist", () =>
          h.engine.invalidate("persist", { start: 0, end: 1 }),
        ),
      );
      await tick(10);
      openings[0]?.gate.reject(failed());
      await tick();
      expect(h.stopped).toMatchObject([
        { cacheId: "persist", reason: "unavailable" },
      ]);

      await settle(h, openings[1], outcome, clearing, clearAt, [
        before,
        during,
      ]);
    });
  }
});
