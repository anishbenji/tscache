import { afterEach, describe, expect, it, vi } from "vitest";
import { clearDisk } from "../src/persist/clear-disk";
import type { PersistStore } from "../src/persist/store";
import { deferred, MemoryStore } from "./persist-memory-store";
import { fixture, tracked } from "./persist-test-helpers";

// Implementer tests (architecture §4.10.7, N66; user decision #11 (b),
// 2026-11-02): the clear-only database call of the hostings that do not
// persist. It opens the database only if it exists, empties it in one
// strict transaction under the clear job's bound (N61), and closes it.
// Time is Vitest's fake clock; the store is the MemoryStore seam.

afterEach(() => {
  vi.useRealTimers();
});

/** A MemoryStore holding two caches' records, its close() observed. */
function seeded(): { store: MemoryStore; close: ReturnType<typeof vi.fn> } {
  const store = new MemoryStore();
  store.seed("persist", fixture({}, [0, 3]));
  store.seed("other", fixture({ id: "other" }, [5]));
  const close = vi.fn(store.close.bind(store));
  store.close = close;
  return { store, close };
}

const empty = { cache: undefined, pages: [] };

const clearCalls = (store: MemoryStore) =>
  store.log.filter((call) => call.kind === "clearAll").length;

describe("clearDisk (§4.10.7, N66)", () => {
  it("opens only an existing database, empties every cache's records in one call, and closes it", async () => {
    const { store, close } = seeded();
    const openStore = vi.fn(async () => store);
    await clearDisk(openStore);
    expect(openStore.mock.calls).toEqual([[{ ifExists: true }]]);
    expect(store.log.map((call) => call.kind)).toEqual(["clearAll"]);
    expect(store.records("persist")).toEqual(empty);
    expect(store.records("other")).toEqual(empty);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("without a database it does nothing more: no store, no call", async () => {
    const openStore = vi.fn(async () => undefined);
    await clearDisk(openStore);
    expect(openStore.mock.calls).toEqual([[{ ifExists: true }]]);
  });

  it("a database that fails to open fails the clear at once, without a retry", async () => {
    vi.useFakeTimers({ now: 0 });
    const openStore = vi.fn(() =>
      Promise.reject(Object.assign(new Error("no"), { name: "UnknownError" })),
    );
    const cleared = tracked(clearDisk(openStore));
    await vi.advanceTimersByTimeAsync(0);
    expect(cleared.done).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(openStore).toHaveBeenCalledTimes(1);
  });

  it("a rejected clear is retried after debounceMs until it succeeds", async () => {
    vi.useFakeTimers({ now: 0 });
    const { store, close } = seeded();
    store.fail("clearAll", 2);
    const cleared = tracked(clearDisk(async () => store));
    await vi.advanceTimersByTimeAsync(0);
    expect(clearCalls(store)).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(clearCalls(store)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(clearCalls(store)).toBe(2);
    expect(cleared.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(clearCalls(store)).toBe(3);
    await cleared.promise;
    expect(store.records("persist")).toEqual(empty);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("a clear that keeps failing settles within timeoutMs, leaves the records and closes the store", async () => {
    vi.useFakeTimers({ now: 0 });
    const { store, close } = seeded();
    store.fail("clearAll", Number.POSITIVE_INFINITY);
    const cleared = tracked(clearDisk(async () => store));
    await vi.advanceTimersByTimeAsync(5000);
    expect(cleared.done).toBe(true);
    // Attempts at 0, 1000, 2000, 3000 and 4000 ms; none at the deadline.
    expect(clearCalls(store)).toBe(5);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(clearCalls(store)).toBe(5);
    expect(store.records("persist").pages).toHaveLength(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("a clear still pending at the deadline is abandoned: the call settles, nothing is retried, the store closes", async () => {
    vi.useFakeTimers({ now: 0 });
    const { store, close } = seeded();
    const gate = store.gate("clearAll");
    const cleared = tracked(clearDisk(async () => store));
    await gate.entered;
    await vi.advanceTimersByTimeAsync(4999);
    expect(cleared.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(cleared.done).toBe(true);
    gate.reject(Object.assign(new Error("late"), { name: "AbortError" }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(clearCalls(store)).toBe(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("a database that opens after the deadline is closed without a clear", async () => {
    vi.useFakeTimers({ now: 0 });
    const { store, close } = seeded();
    const opening = deferred<PersistStore | undefined>();
    const cleared = tracked(clearDisk(() => opening.promise));
    await vi.advanceTimersByTimeAsync(5000);
    expect(cleared.done).toBe(true);
    opening.resolve(store);
    await vi.advanceTimersByTimeAsync(0);
    expect(clearCalls(store)).toBe(0);
    expect(close).toHaveBeenCalledTimes(1);
    expect(store.records("persist").pages).toHaveLength(1);
  });

  it("the deadline counts from startedAt", async () => {
    vi.useFakeTimers({ now: 0 });
    await vi.advanceTimersByTimeAsync(3000);
    const { store } = seeded();
    store.fail("clearAll", Number.POSITIVE_INFINITY);
    const cleared = tracked(clearDisk(async () => store, { startedAt: 0 }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(cleared.done).toBe(true);
    // Attempts at 3000 and 4000 ms: 5000 ms from startedAt.
    expect(clearCalls(store)).toBe(2);
  });

  it("debounceMs and timeoutMs are options", async () => {
    vi.useFakeTimers({ now: 0 });
    const { store } = seeded();
    store.fail("clearAll", Number.POSITIVE_INFINITY);
    const cleared = tracked(
      clearDisk(async () => store, { debounceMs: 100, timeoutMs: 450 }),
    );
    await vi.advanceTimersByTimeAsync(450);
    expect(cleared.done).toBe(true);
    // Attempts at 0, 100, 200, 300 and 400 ms.
    expect(clearCalls(store)).toBe(5);
  });
});
