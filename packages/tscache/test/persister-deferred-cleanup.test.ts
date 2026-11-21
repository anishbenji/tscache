import { describe, expect, it } from "vitest";
import { durably } from "../src/persist/persister";
import {
  clearAll,
  fakeTime,
  finish,
  harness,
  tick,
  writes,
} from "./persist-harness";
import { config, fixture, tracked } from "./persist-test-helpers";

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
