import { describe, expect, it } from "vitest";
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
});
