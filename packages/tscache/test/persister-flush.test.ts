import { describe, expect, it } from "vitest";
import { Persister } from "../src/persist/persister";
import type { PageRecord } from "../src/persist/records";
import {
  clearAll,
  fakeTime,
  finish,
  harness,
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

fakeTime();
describe("write-behind scheduling and plans (§4.10.6)", () => {
  it("batches synchronous changes, waits 1000ms of quiet, and writes once", async () => {
    const h = await opened();
    for (let i = 0; i < 20; i++) h.engine.put("persist", batch([i]));
    await tick(999);
    expect(writes(h.store)).toHaveLength(0);
    await tick(1);
    expect(writes(h.store)).toHaveLength(1);
    expectRecords(h.store.records("persist"), h.engine);
  });
  it("a feed changing every 500ms is written by maxDelayMs=5000", async () => {
    const h = await opened();
    for (let i = 0; i < 10; i++) {
      h.engine.put("persist", batch([i]));
      await tick(500);
    }
    expect(writes(h.store).length).toBeGreaterThan(0);
    await finish(h.persister.flush());
    expectRecords(h.store.records("persist"), h.engine);
  });
  it.each(["invalidate", "clear"])(
    "%s is due at once in a strict transaction",
    async (kind) => {
      const h = await opened();
      h.engine.put("persist", batch([0, 7]));
      await finish(h.persister.flush());
      h.store.log.length = 0;
      if (kind === "clear") h.engine.clear("persist");
      else h.engine.invalidate("persist", { start: 1, end: 1 });
      expect(writes(h.store)).toEqual([]);
      await tick();
      expect(writes(h.store)).toHaveLength(1);
      expect(writes(h.store)[0]?.plan.strict).toBe(true);
      expectRecords(h.store.records("persist"), h.engine);
    },
  );
  it("incremental dirty page ranges merge, untouched pages are not put and flush never reads", async () => {
    const h = await opened();
    h.engine.put("persist", batch([-8, 0, 4, 8, 12]));
    await finish(h.persister.flush());
    h.store.log.length = 0;
    h.engine.put("persist", batch([0, 4]));
    h.engine.put("persist", batch([12]));
    await finish(h.persister.flush());
    expect(h.store.log.map((c) => c.kind)).toEqual(["write"]);
    expect(writes(h.store)[0]?.plan.deletePages).toEqual([
      { start: 0, end: 1 },
      { start: 3, end: 3 },
    ]);
    expect(
      writes(h.store)[0]?.plan.putPages.map((p: PageRecord) => p.page),
    ).toEqual([0, 1, 3]);
    expectRecords(h.store.records("persist"), h.engine);
  });
  it("a dirty page range inserted ahead of later ones keeps the later ones", async () => {
    const h = await opened();
    h.engine.put("persist", batch([-8, 0, 4, 8, 12, 20]));
    await finish(h.persister.flush());
    h.store.log.length = 0;
    h.engine.put("persist", batch([12]));
    h.engine.put("persist", batch([20]));
    h.engine.put("persist", batch([0]));
    await finish(h.persister.flush());
    expect(writes(h.store)[0]?.plan.deletePages).toEqual([
      { start: 0, end: 0 },
      { start: 3, end: 3 },
      { start: 5, end: 5 },
    ]);
    expect(
      writes(h.store)[0]?.plan.putPages.map((p: PageRecord) => p.page),
    ).toEqual([0, 3, 5]);
    expectRecords(h.store.records("persist"), h.engine);
  });
  it.each(["clear", "version-mismatch", "first-version"])(
    "%s causes a full rewrite",
    async (kind) => {
      const h = await opened(kind === "first-version" ? {} : { version: "v1" });
      h.engine.put("persist", batch([-4, 0, 4]));
      await finish(h.persister.flush());
      h.store.log.length = 0;
      if (kind === "clear") h.engine.clear("persist");
      else h.engine.put("persist", { ...batch([0]), meta: { version: "v2" } });
      await finish(h.persister.flush());
      expect(writes(h.store)[0]?.plan.deletePages).toEqual(allPages);
      expectRecords(h.store.records("persist"), h.engine);
    },
  );
  it("watermark forward writes only cache metadata; provisional changes write nothing", async () => {
    const h = await opened({ finalizedUntil: 10 });
    h.engine.put("persist", batch([0]));
    await finish(h.persister.flush());
    h.store.log.length = 0;
    h.engine.setFinalizedUntil("persist", 20);
    await finish(h.persister.flush());
    expect(writes(h.store)[0]?.plan).toMatchObject({
      deletePages: [],
      putPages: [],
      putCache: { finalizedUntil: 20 },
      strict: false,
    });
    h.store.log.length = 0;
    h.engine.put("persist", batch([25]));
    await tick(10000);
    await finish(h.persister.flush());
    expect(writes(h.store)).toEqual([]);
  });
  it("flush(id), flush(all) and close settle their writes; close is idempotent", async () => {
    const h = await opened();
    await finish(h.persister.flush("missing"));
    await finish(h.persister.flush("persist"));
    expect(writes(h.store)).toEqual([]);
    h.engine.cache(config({ id: "B" }));
    await h.persister.open("B");
    h.engine.put("persist", batch([0]));
    h.engine.put("B", batch([4]));
    const gate = h.store.gate("write");
    const flushing = tracked(h.persister.flush());
    await tick();
    await gate.entered;
    expect(flushing.done).toBe(false);
    gate.release();
    await flushing.promise;
    expect(writes(h.store)).toHaveLength(2);
    expectRecords(h.store.records("B"), h.engine, "B");
    h.engine.put("persist", batch([1]));
    const pending = h.store.gate("write");
    const closing = tracked(h.persister.close());
    await tick();
    await pending.entered;
    expect(closing.done).toBe(false);
    pending.release();
    await closing.promise;
    await finish(h.persister.close());
    await finish(h.persister.flush());
    await expect(h.store.read("persist")).rejects.toMatchObject({
      name: "InvalidStateError",
    });
  });
  it("a request during a running flush is a second job, built from later memory", async () => {
    const h = await opened();
    h.engine.put("persist", batch([0]));
    const gate = h.store.gate("write");
    const first = h.persister.flush();
    await tick();
    await gate.entered;
    h.engine.put("persist", batch([4]));
    const second = tracked(h.persister.flush());
    await tick();
    expect(writes(h.store)).toHaveLength(1);
    expect(second.done).toBe(false);
    gate.release();
    await first;
    await second.promise;
    expect(writes(h.store)).toHaveLength(2);
    expectRecords(h.store.records("persist"), h.engine);
  });
  it("a rejected attempt retries after debounceMs, carrying dirty state changed meanwhile", async () => {
    const h = await opened();
    h.store.fail("write", 1);
    h.engine.put("persist", batch([0]));
    const flushing = tracked(h.persister.flush());
    await tick();
    expect(flushing.done).toBe(false);
    h.engine.put("persist", batch([4]));
    await tick(999);
    expect(writes(h.store)).toHaveLength(1);
    await tick(1);
    await flushing.promise;
    expect(writes(h.store)).toHaveLength(2);
    expectRecords(h.store.records("persist"), h.engine);
    expect(
      writes(h.store)[1]?.plan.putPages.map((p: PageRecord) => p.page),
    ).toEqual([0, 1]);
    await tick(10000);
    expect(writes(h.store)).toHaveLength(2);
    expect(h.stopped).toEqual([]);
  });
  it("rejections exhaust one deadline, preserve last error and run one cleanup, never writing again", async () => {
    const h = await opened();
    h.engine.put("persist", batch([0]));
    h.store.fail("write", 5, "NotReadableError", "disk refused");
    const flushing = tracked(h.persister.flush());
    await tick(4999);
    expect(h.stopped).toEqual([]);
    expect(flushing.done).toBe(false);
    // The next attempt must not get a fresh deadline.
    await tick(1);
    await flushing.promise;
    await h.persister.durable("persist");
    expect(h.stopped).toEqual([
      {
        cacheId: "persist",
        reason: "error",
        error: { name: "NotReadableError", message: "disk refused" },
      },
    ]);
    const cleanup = writes(h.store).at(-1);
    expect(cleanup?.plan).toEqual({
      deletePages: allPages,
      putPages: [],
      putCache: null,
      strict: true,
    });
    const count = writes(h.store).length;
    h.engine.put("persist", batch([4]));
    await finish(h.persister.flush());
    await tick(10000);
    expect(writes(h.store)).toHaveLength(count);
  });
  it("a hung write stops unavailable; late commit is followed by cleanup", async () => {
    const h = await opened();
    h.engine.put("persist", batch([0]));
    const gate = h.store.gate("write");
    const flushing = h.persister.flush();
    await tick();
    await gate.entered;
    await tick(5000);
    await flushing;
    expect(h.stopped).toEqual([{ cacheId: "persist", reason: "unavailable" }]);
    expect(writes(h.store)).toHaveLength(2);
    gate.release();
    await tick();
    await h.persister.durable("persist");
    expect(h.store.records("persist")).toEqual({ cache: undefined, pages: [] });
    expect(h.stopped).toHaveLength(1);
  });
  it("clearAll clears unopened cache records and drops the pre-call dirty state", async () => {
    const h = await opened();
    h.store.seed("unopened", fixture({ id: "unopened" }));
    h.engine.put("persist", batch([0]));
    const clearing = clearAll(h);
    await tick();
    await clearing;
    await finish(h.persister.flush());
    expect(h.store.records("unopened")).toEqual({
      cache: undefined,
      pages: [],
    });
    expect(writes(h.store)).toEqual([]);
  });
  it("clearAll with no database passes ifExists, creates none, and later open can open normally", async () => {
    const h = harness();
    let existing = false;
    const calls: ({ ifExists?: boolean } | undefined)[] = [];
    const p = new Persister(
      h.engine,
      async (options?: { ifExists?: boolean }) => {
        calls.push(options);
        return existing ? h.store : undefined;
      },
    );
    const clearing = p.clearAll();
    await tick();
    await clearing;
    expect(calls).toEqual([{ ifExists: true }]);
    existing = true;
    h.engine.cache(config());
    await p.open("persist");
    expect(calls).toEqual([{ ifExists: true }, undefined]);
  });
});
