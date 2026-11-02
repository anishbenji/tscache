import { describe, expect, it } from "vitest";
import type { PageRecord } from "../src/persist/records";
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
  expectRecords,
  tracked,
} from "./persist-test-helpers";

fakeTime();
describe("removal durability (§4.10.6 d/e, N49, N58)", () => {
  it.each([1, 2])(
    "waits through %i rejected writes, then acknowledges the strict successful plan",
    async (failures) => {
      const h = await opened();
      h.engine.put("persist", batch([0, 3]));
      await finish(h.persister.flush());
      h.store.log.length = 0;
      h.store.fail("write", failures);
      h.engine.invalidate("persist", { start: 1, end: 1 });
      const durable = tracked(h.persister.durable("persist"));
      await tick();
      for (let n = 0; n < failures; n++) {
        expect(durable.done).toBe(false);
        await tick(999);
        expect(durable.done).toBe(false);
        await tick(1);
      }
      await durable.promise;
      expect(writes(h.store)).toHaveLength(failures + 1);
      expect(writes(h.store).every((c) => c.plan.strict)).toBe(true);
      expectRecords(h.store.records("persist"), h.engine);
      expect(
        h.store
          .records("persist")
          .pages.flatMap((p: PageRecord) => p.snapshot.coverage),
      ).not.toContainEqual({ start: 0, end: 3 });
    },
  );
  it.each([false, true])(
    "deadline stop waits for cleanup, cleanup failing=%s",
    async (cleanupFails) => {
      const h = await opened();
      h.engine.put("persist", batch([0, 3]));
      await finish(h.persister.flush());
      const before = h.store.records("persist");
      h.store.log.length = 0;
      h.store.fail("write", 5);
      h.engine.invalidate("persist", { start: 1, end: 1 });
      const durable = tracked(h.persister.durable("persist"));
      await tick(4000);
      const cleanup = h.store.gate("write");
      if (cleanupFails) h.store.fail("write", 1);
      await tick(999);
      expect(durable.done).toBe(false);
      await tick(1);
      await tick();
      await cleanup.entered;
      expect(h.stopped).toHaveLength(1);
      expect(durable.done).toBe(false);
      expect(writes(h.store).at(-1)?.plan).toEqual({
        deletePages: allPages,
        putPages: [],
        putCache: null,
        strict: true,
      });
      cleanup.release();
      await durable.promise;
      expect(h.store.records("persist")).toEqual(
        cleanupFails ? before : { cache: undefined, pages: [] },
      );
    },
  );
  it("a held write stops unavailable and durable waits for its ordered cleanup", async () => {
    const h = await opened();
    h.engine.put("persist", batch([0, 3]));
    await finish(h.persister.flush());
    const write = h.store.gate("write");
    h.engine.invalidate("persist", { start: 1, end: 1 });
    const durable = tracked(h.persister.durable("persist"));
    await tick();
    await tick();
    await write.entered;
    const cleanup = h.store.gate("write");
    await tick(5000);
    await tick();
    await cleanup.entered;
    expect(durable.done).toBe(false);
    expect(h.stopped[0]?.reason).toBe("unavailable");
    write.release();
    cleanup.release();
    await durable.promise;
    expect(h.store.records("persist")).toEqual({ cache: undefined, pages: [] });
  });
  it("a held cleanup also has a deadline and releases durable even if its transaction never answers", async () => {
    const h = await opened();
    h.engine.put("persist", batch([0]));
    await finish(h.persister.flush());
    h.store.fail("write", 5);
    h.engine.invalidate("persist", { start: 0, end: 0 });
    const durable = tracked(h.persister.durable("persist"));
    await tick(4000);
    const cleanup = h.store.gate("write");
    await tick(1000);
    await tick();
    await cleanup.entered;
    expect(durable.done).toBe(false);
    await tick(4999);
    expect(durable.done).toBe(false);
    await tick(1);
    await durable.promise;
    expect(h.stopped).toHaveLength(1);
    cleanup.release();
    await tick();
  });
  it("durable is immediate without a tracked cache or pending removal; counters count remove and clear only", async () => {
    const h = await opened();
    await h.persister.durable("unknown");
    await h.persister.durable("persist");
    expect(h.persister.removals("unknown")).toBe(0);
    h.engine.put("persist", batch([0]));
    expect(h.persister.removals("persist")).toBe(0);
    h.engine.invalidate("persist", { start: 0, end: 0 });
    expect(h.persister.removals("persist")).toBe(1);
    h.engine.clear("persist");
    expect(h.persister.removals("persist")).toBe(2);
    h.engine.setFinalizedUntil("persist", 10);
    expect(h.persister.removals("persist")).toBe(3);
    h.engine.setFinalizedUntil("persist", 20);
    expect(h.persister.removals("persist")).toBe(3);
    await tick();
    await h.persister.durable("persist");
  });
  it("a removal during a write is not acknowledged by that earlier plan", async () => {
    const h = await opened();
    h.engine.put("persist", batch([0, 7]));
    await finish(h.persister.flush());
    const first = h.store.gate("write");
    h.engine.invalidate("persist", { start: 0, end: 0 });
    await tick();
    await tick();
    await first.entered;
    const second = h.store.gate("write");
    h.engine.invalidate("persist", { start: 7, end: 7 });
    const durable = tracked(h.persister.durable("persist"));
    first.release();
    await tick();
    await tick();
    await second.entered;
    expect(durable.done).toBe(false);
    second.release();
    await durable.promise;
    expectRecords(h.store.records("persist"), h.engine);
  });
  it.each([
    "put",
    "invalidate",
    "clear",
    "first-watermark",
    "watermark-back",
    "version",
  ])("strict exactly when carrying removal: %s", async (operation) => {
    const h = await opened({
      version: "v1",
      ...(operation === "first-watermark" ? {} : { finalizedUntil: 20 }),
    });
    h.engine.put("persist", batch([0, 7]));
    await finish(h.persister.flush());
    h.store.log.length = 0;
    switch (operation) {
      case "put":
        h.engine.put("persist", batch([1]));
        break;
      case "invalidate":
        h.engine.invalidate("persist", { start: 1, end: 1 });
        break;
      case "clear":
        h.engine.clear("persist");
        break;
      case "first-watermark":
        h.engine.setFinalizedUntil("persist", 5);
        break;
      case "watermark-back":
        h.engine.setFinalizedUntil("persist", 5);
        break;
      case "version":
        h.engine.put("persist", { ...batch([1]), meta: { version: "v2" } });
        break;
    }
    await finish(h.persister.flush());
    expect(writes(h.store)[0]?.plan.strict).toBe(operation !== "put");
    expectRecords(h.store.records("persist"), h.engine);
  });
  it.each([1, 2, Infinity])(
    "clearAll stays pending through failures=%s and has no cleanup after deadline stop",
    async (failures) => {
      const h = await opened();
      h.engine.put("persist", batch([0]));
      await finish(h.persister.flush());
      h.store.log.length = 0;
      h.store.fail("clearAll", failures);
      const clearing = tracked(clearAll(h));
      await tick();
      expect(clearing.done).toBe(false);
      await tick(failures === Infinity ? 4999 : failures * 1000 - 1);
      expect(clearing.done).toBe(false);
      await tick(1);
      await clearing.promise;
      expect(writes(h.store)).toEqual([]);
      expect(h.stopped).toHaveLength(failures === Infinity ? 1 : 0);
    },
  );
});
