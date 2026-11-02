import { afterEach, describe, expect, it, vi } from "vitest";
import { Engine } from "../src/engine/engine";
import {
  type ClearChunk,
  ClearOnlyPersistence,
} from "../src/persist/clear-only";
import * as lazy from "../src/persist/lazy";
import type { PersistStore } from "../src/persist/store";
import { deferred, MemoryStore } from "./persist-memory-store";
import { all, batch, config, fixture, tracked } from "./persist-test-helpers";

// Implementer tests (architecture §4.10.7, §4.10.8, N66; user decision #11
// (b), 2026-11-02): the persistence of the dedicated-worker and in-process
// hostings, which persist nothing and clear the disk at `clearAll`. The
// chunk's import is a gate the test opens; the deadline tests run under
// fake timers.

afterEach(() => {
  vi.useRealTimers();
});

/** A clear-only persistence over a seeded MemoryStore, its chunk held until `release`. */
function clearOnly(timeoutMs?: number) {
  const engine = new Engine();
  const store = new MemoryStore();
  store.seed("persist", fixture({}, [0, 3]));
  const chunk = deferred<ClearChunk>();
  const load = vi.fn(() => chunk.promise);
  // Each opening is a connection of its own over the one store, as
  // IndexedDB gives; closing one closes only it.
  const closed: boolean[] = [];
  const openStore = vi.fn(async (): Promise<PersistStore> => {
    const index = closed.push(false) - 1;
    return {
      read: (cacheId, pages) => store.read(cacheId, pages),
      write: (cacheId, plan) => store.write(cacheId, plan),
      clearAll: () => store.clearAll(),
      close: () => {
        closed[index] = true;
      },
    };
  });
  const persistence = new ClearOnlyPersistence(
    engine,
    load,
    openStore,
    timeoutMs === undefined ? {} : { timeoutMs },
  );
  return {
    engine,
    store,
    load,
    openStore,
    closed,
    persistence,
    release: () => chunk.resolve(lazy),
    fail: (error: unknown) => chunk.reject(error),
  };
}

const empty = { cache: undefined, pages: [] };

describe("clear-only persistence (§4.10.7, N66)", () => {
  it("a page that never calls clearAll loads nothing: opens, ops and flush touch neither the chunk nor the disk", async () => {
    const h = clearOnly();
    h.engine.cache(config());
    await h.persistence.open("persist");
    const result = h.persistence.durably("persist", () =>
      h.engine.put("persist", batch([0, 1])),
    );
    // In the op's own call, as without persistence.
    expect(result).toEqual({ warnings: [] });
    h.persistence.durably("persist", () =>
      h.engine.invalidate("persist", { start: 0, end: 0 }),
    );
    h.persistence.flush();
    await Promise.resolve();
    expect(h.load).not.toHaveBeenCalled();
    expect(h.openStore).not.toHaveBeenCalled();
    expect(h.store.log).toEqual([]);
    // A persisted cache is not loaded here (N45): the stored 3 never shows.
    expect(h.engine.get("persist", all).timestamps).toEqual(
      new Float64Array([0, 1]),
    );
  });

  it("clearAll empties memory in its call, then loads the chunk and answers once the disk is empty", async () => {
    const h = clearOnly();
    h.engine.cache(config());
    h.engine.put("persist", batch([0, 1]));
    const cleared = tracked(h.persistence.clearAll() as Promise<void>);
    expect(h.engine.get("persist", all).timestamps).toEqual(
      new Float64Array([]),
    );
    expect(h.load).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(cleared.done).toBe(false);
    h.release();
    await cleared.promise;
    expect(h.openStore.mock.calls).toEqual([[{ ifExists: true }]]);
    expect(h.store.log.map((call) => call.kind)).toEqual(["clearAll"]);
    expect(h.store.records("persist")).toEqual(empty);
  });

  it("a chunk that fails to load: clearAll still answers, memory cleared; a later clearAll tries again", async () => {
    const h = clearOnly();
    h.engine.cache(config());
    h.engine.put("persist", batch([0, 1]));
    const first = h.persistence.clearAll() as Promise<void>;
    h.fail(new TypeError("Failed to fetch dynamically imported module"));
    await first;
    expect(h.engine.get("persist", all).timestamps).toEqual(
      new Float64Array([]),
    );
    expect(h.store.records("persist").pages).toHaveLength(1);
    h.load.mockImplementation(async () => lazy);
    await h.persistence.clearAll();
    expect(h.load).toHaveBeenCalledTimes(2);
    expect(h.store.records("persist")).toEqual(empty);
  });

  it("a clear that fails changes nothing else: no store is kept, and a later clearAll runs again", async () => {
    vi.useFakeTimers({ now: 0 });
    const h = clearOnly();
    h.release();
    h.store.fail("clearAll", Number.POSITIVE_INFINITY);
    const first = tracked(h.persistence.clearAll() as Promise<void>);
    await vi.advanceTimersByTimeAsync(5000);
    expect(first.done).toBe(true);
    const failed = h.store.log.length;
    expect(h.store.records("persist").pages).toHaveLength(1);
    h.store.recover("clearAll");
    const second = tracked(h.persistence.clearAll() as Promise<void>);
    await vi.advanceTimersByTimeAsync(0);
    await second.promise;
    expect(h.store.log.length).toBe(failed + 1);
    expect(h.openStore).toHaveBeenCalledTimes(2);
    expect(h.closed).toEqual([true, true]);
    expect(h.store.records("persist")).toEqual(empty);
  });

  it("an import that never settles: clearAll answers timeoutMs after its call", async () => {
    vi.useFakeTimers({ now: 0 });
    const h = clearOnly();
    const cleared = tracked(h.persistence.clearAll() as Promise<void>);
    await vi.advanceTimersByTimeAsync(4999);
    expect(cleared.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(cleared.done).toBe(true);
    expect(h.openStore).not.toHaveBeenCalled();
  });

  it("an import that arrives after the deadline starts no disk work", async () => {
    vi.useFakeTimers({ now: 0 });
    const h = clearOnly();
    const cleared = tracked(h.persistence.clearAll() as Promise<void>);
    await vi.advanceTimersByTimeAsync(5000);
    expect(cleared.done).toBe(true);
    h.release();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.openStore).not.toHaveBeenCalled();
    expect(h.store.log).toEqual([]);
    expect(h.store.records("persist").pages).toHaveLength(1);
  });

  it("a clear still pending when clearAll answers has its connection closed by then", async () => {
    vi.useFakeTimers({ now: 0 });
    const h = clearOnly();
    h.release();
    const gate = h.store.gate("clearAll");
    const cleared = tracked(h.persistence.clearAll() as Promise<void>);
    await gate.entered;
    await vi.advanceTimersByTimeAsync(5000);
    expect(cleared.done).toBe(true);
    expect(h.closed).toEqual([true]);
    gate.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.closed).toEqual([true]);
  });

  it("the import counts against the clear's deadline", async () => {
    vi.useFakeTimers({ now: 0 });
    const h = clearOnly();
    h.store.fail("clearAll", Number.POSITIVE_INFINITY);
    const cleared = tracked(h.persistence.clearAll() as Promise<void>);
    await vi.advanceTimersByTimeAsync(3000);
    h.release();
    await vi.advanceTimersByTimeAsync(2000);
    expect(cleared.done).toBe(true);
    // Attempts at 3000 and 4000 ms: 5 s from the call, not from the chunk.
    expect(h.store.log.filter((call) => call.kind === "clearAll")).toHaveLength(
      2,
    );
  });

  it("a cacheCleared listener that throws is rethrown once the disk part settled", async () => {
    const h = clearOnly();
    h.engine.cache(config());
    h.engine.on("cacheCleared", () => {
      throw new Error("listener");
    });
    const cleared = h.persistence.clearAll() as Promise<void>;
    h.release();
    await expect(cleared).rejects.toThrow("listener");
    expect(h.store.records("persist")).toEqual(empty);
  });
});
