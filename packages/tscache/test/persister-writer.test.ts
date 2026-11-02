import { describe, expect, it } from "vitest";
import { fakeTime, finish, opened, tick, writes } from "./persist-harness";
import {
  allPages,
  batch,
  config,
  expectRecords,
  tracked,
} from "./persist-test-helpers";

fakeTime();
describe("one writer, priority and one deadline (§4.10.6 f, N61)", () => {
  it.each([
    "reject all",
    "hold removal",
    "ten additions",
    "hold other addition",
  ])("durable is bounded by two deadlines: %s", async (scenario) => {
    const h = await opened();
    h.engine.put("persist", batch([0, 3]));
    await finish(h.persister.flush());
    h.store.log.length = 0;
    const flushes: Promise<void>[] = [];
    const held =
      scenario.startsWith("hold") || scenario === "ten additions"
        ? h.store.gate("write")
        : undefined;
    if (scenario === "reject all") h.store.fail("write", Infinity);
    if (scenario === "ten additions" || scenario === "hold other addition") {
      const n = scenario === "ten additions" ? 10 : 1;
      for (let i = 0; i < n; i++) {
        const id = `other-${i}`;
        h.engine.cache(config({ id }));
        await h.persister.open(id);
        h.engine.put(id, batch([0]));
        flushes.push(h.persister.flush(id));
      }
      await tick();
      if (held !== undefined) await held.entered;
    }
    h.engine.invalidate("persist", { start: 1, end: 1 });
    const durable = tracked(h.persister.durable("persist"));
    await tick();
    if (scenario === "hold removal") await held?.entered;
    await tick(10000);
    await durable.promise;
    expect(durable.done).toBe(true);
    held?.release();
    await tick();
    await Promise.all(flushes);
  });
  it("removals run before queued additions and no second store call starts before a live attempt ends", async () => {
    const h = await opened();
    for (const id of ["A", "B"]) {
      h.engine.cache(config({ id }));
      await h.persister.open(id);
    }
    h.engine.put("persist", batch([0]));
    const hold = h.store.gate("write");
    const first = h.persister.flush("persist");
    await tick();
    await hold.entered;
    h.engine.put("A", batch([0]));
    const addition = h.persister.flush("A");
    h.engine.invalidate("B", { start: 0, end: 0 });
    const removal = h.persister.durable("B");
    await tick();
    expect(writes(h.store).map((c) => c.cacheId)).toEqual(["persist"]);
    hold.release();
    await first;
    await tick();
    await removal;
    await addition;
    expect(writes(h.store).map((c) => c.cacheId)).toEqual([
      "persist",
      "B",
      "A",
    ]);
  });
  it("failed addition retry coalesces with a new removal, strict, due immediately, union of pages", async () => {
    const h = await opened();
    h.engine.put("persist", batch([0, 7]));
    await finish(h.persister.flush());
    h.store.log.length = 0;
    h.store.fail("write", 1);
    h.engine.put("persist", batch([0], [40]));
    const flush = h.persister.flush();
    await tick();
    await tick(700);
    h.engine.invalidate("persist", { start: 7, end: 7 });
    const durable = h.persister.durable("persist");
    await tick();
    await durable;
    await flush;
    expect(writes(h.store)).toHaveLength(2);
    expect(writes(h.store)[1]?.plan).toMatchObject({
      deletePages: [{ start: 0, end: 1 }],
      strict: true,
    });
    expectRecords(h.store.records("persist"), h.engine);
    await tick(1000);
    expect(writes(h.store)).toHaveLength(2);
  });
  it("coalesced removal keeps the earlier addition deadline instead of starting a new one", async () => {
    const h = await opened();
    h.store.fail("write", Infinity);
    h.engine.put("persist", batch([0]));
    const flushing = h.persister.flush();
    await tick(700);
    h.engine.invalidate("persist", { start: 0, end: 0 });
    const durable = h.persister.durable("persist");
    await tick(4299);
    expect(h.stopped).toEqual([]);
    await tick(1);
    expect(h.stopped).toHaveLength(1);
    await flushing;
    await durable;
  });
  it("a retry due after the deadline never runs; custom timeoutMs and debounceMs are honored", async () => {
    const h = await opened({}, { debounceMs: 3000, timeoutMs: 5000 });
    h.engine.put("persist", batch([0]));
    h.store.fail("write", Infinity);
    const flushing = h.persister.flush();
    await tick(4999);
    expect(writes(h.store)).toHaveLength(2);
    expect(h.stopped).toEqual([]);
    await tick(1);
    await flushing;
    await h.persister.durable("persist");
    expect(writes(h.store)).toHaveLength(3);
    expect(writes(h.store).at(-1)?.plan.putCache).toBeNull();
  });
  it("stuck addition stops its cache despite a queued removal, then durable waits for cleanup", async () => {
    const h = await opened();
    h.engine.put("persist", batch([0, 3]));
    const gate = h.store.gate("write");
    const flushing = h.persister.flush();
    await tick();
    await gate.entered;
    h.engine.invalidate("persist", { start: 1, end: 1 });
    const durable = tracked(h.persister.durable("persist"));
    await tick(5000);
    await flushing;
    expect(h.stopped[0]?.reason).toBe("unavailable");
    expect(durable.done).toBe(false);
    expect(writes(h.store)).toHaveLength(2);
    expect(writes(h.store)[1]?.plan).toEqual({
      deletePages: allPages,
      putPages: [],
      putCache: null,
      strict: true,
    });
    gate.release();
    await durable.promise;
    expect(h.store.records("persist")).toEqual({ cache: undefined, pages: [] });
  });
});
