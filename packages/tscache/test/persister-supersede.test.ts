import { describe, expect, it, vi } from "vitest";
import { Engine, observeCaches } from "../src/engine/engine";
import { durably, Persister } from "../src/persist/persister";
import { PAGE_BYTES, span } from "./m3-memory-helpers";
import {
  clearAll,
  fakeTime,
  finish,
  harness,
  opened,
  tick,
  writes,
} from "./persist-harness";
import { MemoryStore } from "./persist-memory-store";
import {
  all,
  batch,
  config,
  fixture,
  recordsOf,
  tracked,
} from "./persist-test-helpers";

fakeTime();

const empty = { cache: undefined, pages: [] };
const failure = new Error("disk clear failed");
const stopped = (cacheId: string) => ({ cacheId, reason: "superseded" });

describe("M5 §6: Persister supersedes", () => {
  it("1: stops every tracked cache, discards queued writes and keeps the disk records", async () => {
    const h = harness();
    for (const id of ["persist", "other"]) {
      h.store.seed(id, fixture({ id }));
      h.engine.cache(config({ id }));
      await h.persister.open(id);
      h.engine.put(id, batch([8]));
    }
    const before = [h.store.records("persist"), h.store.records("other")];
    expect(writes(h.store)).toEqual([]);

    h.persister.supersede();
    expect(h.stopped).toHaveLength(2);
    expect(h.stopped).toEqual(
      expect.arrayContaining([stopped("persist"), stopped("other")]),
    );
    h.engine.put("persist", batch([12]));
    h.engine.clear("other");
    await finish(h.persister.flush());
    await tick(10_000);

    expect(writes(h.store)).toEqual([]);
    expect([h.store.records("persist"), h.store.records("other")]).toEqual(
      before,
    );
    expect(h.stopped).toHaveLength(2);
  });

  it("2: opens after superseding read nothing, even after a failed clear", async () => {
    const h = harness({ debounceMs: 10, timeoutMs: 25 });
    const ids = ["before-failed-clear", "after-failed-clear"];
    for (const id of ids) {
      h.store.seed(id, fixture({ id }, [4]));
      h.engine.cache(config({ id }));
    }

    h.persister.supersede();
    await h.persister.open("before-failed-clear");
    expect(h.stopped).toEqual([stopped("before-failed-clear")]);
    expect(h.openStore).not.toHaveBeenCalled();

    h.store.fail("clearAll", Infinity);
    const clearing = clearAll(h);
    await tick(25);
    await clearing;
    await h.persister.open("after-failed-clear");
    await finish(h.persister.flush());
    expect(h.stopped).toEqual(ids.map(stopped));
    expect(h.store.log.every(({ kind }) => kind === "clearAll")).toBe(true);
    expect(h.store.records("after-failed-clear")).toEqual(
      fixture({ id: "after-failed-clear" }, [4]),
    );
    expect(h.engine.get("after-failed-clear", all).timestamps).toHaveLength(0);
  });

  it("3: releases a removal already waiting for durability without writing it", async () => {
    const h = harness();
    const records = fixture({}, [0, 4]);
    h.store.seed("persist", records);
    h.engine.cache(config());
    await h.persister.open("persist");
    const removal = tracked(
      Promise.resolve(
        durably(h.persister, "persist", () =>
          h.engine.invalidate("persist", span(0)),
        ),
      ).then(() => undefined),
    );

    await Promise.resolve();
    expect(removal.done).toBe(false);
    expect(h.engine.coverage("persist", all)).toEqual([span(1, 4)]);
    expect(writes(h.store)).toEqual([]);

    h.persister.supersede();
    await removal.promise;
    await tick(10_000);
    expect(writes(h.store)).toEqual([]);
    expect(h.store.records("persist")).toEqual(records);
  });

  it.each(["succeeds", "fails"])(
    "4: a clear after superseding waits for its disk job when it %s",
    async (outcome) => {
      const h = harness({ debounceMs: 10, timeoutMs: 25 });
      const records = fixture({}, [0, 4]);
      const unopened = fixture({ id: "unopened" }, [8]);
      h.store.seed("persist", records);
      h.store.seed("unopened", unopened);
      h.engine.cache(config());
      await h.persister.open("persist");
      h.persister.supersede();

      const gate = h.store.gate("clearAll");
      const clearing = tracked(clearAll(h));
      await tick();
      await gate.entered;
      expect(clearing.done).toBe(false);
      expect(h.store.records("unopened")).toEqual(unopened);
      if (outcome === "succeeds") {
        gate.release();
      } else {
        h.store.fail("clearAll", Infinity);
        gate.reject(failure);
        await tick();
        expect(clearing.done).toBe(false);
        await tick(25);
      }
      await clearing.promise;
      expect(h.store.records("persist")).toEqual(
        outcome === "succeeds" ? empty : records,
      );
      expect(h.store.records("unopened")).toEqual(
        outcome === "succeeds" ? empty : unopened,
      );
      expect(h.stopped).toEqual([stopped("persist")]);
      expect(writes(h.store)).toEqual([]);
    },
  );

  it.each(["commits", "rejects", "hits its quota"])(
    "5: abandons a running flush even if its transaction later %s",
    async (outcome) => {
      const h = await opened();
      h.engine.put("persist", batch([0]));
      await finish(h.persister.flush());
      const before = h.store.records("persist");
      h.engine.put("persist", batch([4]));
      const taken = recordsOf(h.engine);
      const gate = h.store.gate("write");
      const flushing = h.persister.flush();
      await tick();
      await gate.entered;

      try {
        h.engine.put("persist", batch([8]));
        h.persister.supersede();
        // The flush answers before the abandoned transaction settles.
        await flushing;
        expect(writes(h.store).at(-1)?.settled).toBe(false);
        expect(h.stopped).toEqual([stopped("persist")]);
      } finally {
        if (outcome === "commits") gate.release();
        else if (outcome === "rejects") gate.reject(new Error("write failed"));
        else gate.reject(new DOMException("full", "QuotaExceededError"));
      }

      await tick(10_000);
      expect(writes(h.store)).toHaveLength(2);
      expect(writes(h.store).at(-1)?.settled).toBe(true);
      expect(h.store.records("persist")).toEqual(
        outcome === "commits" ? taken : before,
      );
      expect(h.engine.get("persist", all).timestamps).toEqual(
        new Float64Array([0, 4, 8]),
      );
      expect(h.stopped).toEqual([stopped("persist")]);
    },
  );

  it("6: a second supersede emits nothing and leaves the stop in force", async () => {
    const h = await opened();
    h.persister.supersede();
    expect(h.stopped).toEqual([stopped("persist")]);
    h.persister.supersede();
    expect(h.stopped).toEqual([stopped("persist")]);

    h.engine.cache(config({ id: "later" }));
    await h.persister.open("later");
    h.engine.put("persist", batch([0]));
    h.engine.put("later", batch([4]));
    await finish(h.persister.flush());
    await tick(10_000);
    expect(h.stopped).toEqual([stopped("persist"), stopped("later")]);
    expect(h.store.log.map(({ kind }) => kind)).toEqual(["read"]);
  });

  it("25: superseding changes no cache and emits no engine mutation or reader event", async () => {
    const h = await opened();
    h.engine.cache(config({ id: "plain", persist: false }));
    const onChange = vi.fn();
    const onMutate = vi.fn();
    const onReaderChange = vi.fn();
    const cacheCleared = vi.fn();
    observeCaches(h.engine, {
      onChange,
      onMutate,
      hasReaders: () => true,
      onReaderChange,
    });
    h.engine.on("cacheCleared", cacheCleared);
    h.engine.put("persist", batch([0, 4], [10, 40]), { range: span(0, 4) });
    h.engine.put("plain", batch([8], [80]), { range: span(8, 12) });
    expect(onReaderChange).toHaveBeenCalledTimes(2);
    const reads = () => [
      h.engine.get("persist", all),
      h.engine.get("plain", all),
    ];
    const before = reads();
    for (const listener of [onChange, onMutate, onReaderChange, cacheCleared])
      listener.mockClear();

    h.persister.supersede();
    await tick(10_000);
    for (const listener of [onChange, onMutate, onReaderChange, cacheCleared])
      expect(listener).not.toHaveBeenCalled();
    expect(reads()).toEqual(before);
    expect(h.stopped).toEqual([stopped("persist")]);
  });

  it("26: drops a queued eviction deletion and writes nothing for later evictions", async () => {
    const engine = new Engine({ memoryBudget: 2 * PAGE_BYTES });
    const store = new MemoryStore();
    const persister = new Persister(engine, async () => store);
    engine.cache(config());
    await persister.open("persist");
    engine.put("persist", batch([0, 4]));
    await finish(persister.flush());
    const records = store.records("persist");
    expect(records.pages.map(({ page }) => page)).toEqual([0, 1]);

    engine.put("persist", batch([8]));
    expect(engine.get("persist", span(0)).timestamps).toHaveLength(0);
    const before = engine.memoryStats();
    expect(before.evictedPages).toBe(1);

    persister.supersede();
    expect(engine.memoryStats()).toEqual(before);
    engine.put("persist", batch([12]));
    expect(engine.get("persist", span(4)).timestamps).toHaveLength(0);
    expect(engine.memoryStats().evictedPages).toBe(2);
    await finish(persister.flush());
    await tick(10_000);

    expect(writes(store)).toHaveLength(1);
    expect(store.records("persist")).toEqual(records);
  });

  it.each(["store open", "clearAll"])(
    "27: superseding after a failed %s reports only newly opened caches",
    async (operation) => {
      const h = harness({ debounceMs: 10, timeoutMs: 25 });
      const storeError = new Error("store unavailable");
      h.engine.cache(config());
      h.store.seed("persist", fixture());
      if (operation === "store open") {
        h.openStore.mockRejectedValue(storeError);
        await h.persister.open("persist");
      } else {
        await h.persister.open("persist");
        h.store.fail("clearAll", Infinity);
        const clearing = clearAll(h);
        await tick(25);
        await clearing;
      }
      expect(h.stopped).toHaveLength(1);
      expect(h.stopped[0]).toMatchObject({
        cacheId: "persist",
        reason: operation === "store open" ? "unavailable" : "error",
      });
      const prior = [...h.stopped];
      const log = [...h.store.log];
      const calls = h.openStore.mock.calls.length;
      h.openStore.mockResolvedValue(h.store);
      h.engine.cache(config({ id: "later" }));
      h.store.seed("later", fixture({ id: "later" }));

      h.persister.supersede();
      expect(h.stopped).toEqual(prior);
      await h.persister.open("persist");
      await h.persister.open("later");
      await finish(h.persister.flush());
      expect(h.stopped).toEqual([...prior, stopped("later")]);
      expect(h.openStore).toHaveBeenCalledTimes(calls);
      expect(h.store.log).toEqual(log);
    },
  );

  it.each(["succeeds", "fails"])(
    "27: superseding leaves a pending clear running until it %s",
    async (outcome) => {
      const h = harness({ debounceMs: 10, timeoutMs: 25 });
      const ids = ["persist", "other"];
      for (const id of ids) {
        h.store.seed(id, fixture({ id }));
        h.engine.cache(config({ id }));
        await h.persister.open(id);
      }
      const gate = h.store.gate("clearAll");
      const clearing = tracked(clearAll(h));
      await tick();
      await gate.entered;

      try {
        h.persister.supersede();
        expect(h.stopped).toHaveLength(2);
        expect(h.stopped).toEqual(expect.arrayContaining(ids.map(stopped)));
        await tick();
        expect(clearing.done).toBe(false);
        expect(h.store.records("persist")).toEqual(fixture());
      } finally {
        if (outcome === "succeeds") gate.release();
        else {
          h.store.fail("clearAll", Infinity);
          gate.reject(failure);
        }
      }
      if (outcome === "fails") {
        await tick();
        expect(clearing.done).toBe(false);
        await tick(25);
      }
      await clearing.promise;
      expect(h.stopped).toHaveLength(2);
      for (const id of ids) {
        expect(h.store.records(id)).toEqual(
          outcome === "succeeds" ? empty : fixture({ id }),
        );
      }
      h.engine.cache(config({ id: "later" }));
      const log = [...h.store.log];
      await h.persister.open("later");
      expect(h.stopped.at(-1)).toEqual(stopped("later"));
      expect(h.store.log).toEqual(log);
      expect(writes(h.store)).toEqual([]);
    },
  );

  it("28: a pending clear holds both puts and cross-cache eviction writes", async () => {
    const engine = new Engine({ memoryBudget: PAGE_BYTES });
    const store = new MemoryStore();
    const persister = new Persister(engine, async () => store, {
      debounceMs: 10,
      timeoutMs: 25,
    });
    for (const id of ["persist", "other"]) {
      engine.cache(config({ id }));
      await persister.open(id);
    }
    engine.put("persist", batch([0]));
    await finish(persister.flush());

    const gate = store.gate("clearAll");
    const clearing = tracked(clearAll({ engine, persister }));
    await tick();
    await gate.entered;
    engine.put("other", batch([4]));
    engine.put("persist", batch([8]));
    expect(engine.memoryStats().evictedPages).toBe(1);
    expect(engine.coverage("other", all)).toEqual([]);
    const flushing = persister.flush();

    try {
      await tick(10);
      expect(clearing.done).toBe(false);
      expect(writes(store)).toHaveLength(1);
    } finally {
      gate.release();
    }
    await clearing.promise;
    await finish(flushing);
    expect(store.records("persist")).toEqual(recordsOf(engine));
    expect(store.records("other")).toEqual(recordsOf(engine, "other"));
    expect(store.records("persist").pages.map(({ page }) => page)).toEqual([2]);
    expect(store.records("other")).toEqual(empty);
  });
});
