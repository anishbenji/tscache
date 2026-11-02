import { afterEach, describe, expect, it, vi } from "vitest";
import { Engine } from "../src/engine/engine";
import { HostedPersistence, type LazyPersist } from "../src/persist/hosted";
import * as lazy from "../src/persist/lazy";
import type { Persister } from "../src/persist/persister";
import type { ClientEvents } from "../src/types";
import { deferred, MemoryStore } from "./persist-memory-store";
import {
  all,
  batch,
  config,
  fixture,
  recordsOf,
  tracked,
} from "./persist-test-helpers";

// Implementer tests (architecture §4.10.8): the SharedWorker hosting's
// persistence loads the persister lazily. The chunk's import is a gate the
// test opens; nothing here waits for time except the deadline tests, which
// run under fake timers.

type Stop = ClientEvents["persistStopped"];

afterEach(() => {
  vi.useRealTimers();
});

/** A hosted persistence over a MemoryStore, its chunk held until `release`. */
function hosted(store = new MemoryStore(), timeoutMs?: number) {
  const engine = new Engine();
  const chunk = deferred<LazyPersist>();
  const load = vi.fn(() => chunk.promise);
  const stops: Stop[] = [];
  const persistence = new HostedPersistence(engine, load, async () => store, {
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    onStopped: (event) => stops.push(event),
  });
  return {
    engine,
    store,
    load,
    stops,
    persistence,
    release: () => chunk.resolve(lazy),
    fail: (error: unknown) => chunk.reject(error),
  };
}

const plain = config({ id: "plain", persist: false });

describe("lazily loaded persistence (§4.10.8)", () => {
  it("loads nothing while no cache persists: ops run in their own call, flush does nothing", () => {
    const h = hosted();
    h.engine.cache(plain);
    const result = h.persistence.durably("plain", () =>
      h.engine.put("plain", batch([0, 1])),
    );
    expect(result).toEqual({ warnings: [] });
    h.persistence.durably("persist", () => undefined);
    h.persistence.flush();
    expect(h.load).not.toHaveBeenCalled();
    expect(h.persistence.persister).toBeUndefined();
  });

  it("the first persisted open imports the chunk once; opens answer after the load", async () => {
    const h = hosted();
    h.store.seed("persist", fixture({}, [0, 3]));
    h.engine.cache(config());
    h.engine.cache(config({ id: "other" }));
    const first = tracked(h.persistence.open("persist"));
    const again = tracked(h.persistence.open("persist"));
    const other = tracked(h.persistence.open("other"));
    expect(h.load).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(first.done || again.done || other.done).toBe(false);
    h.release();
    await Promise.all([first.promise, again.promise, other.promise]);
    expect(h.load).toHaveBeenCalledTimes(1);
    expect(h.engine.get("persist", all).timestamps).toEqual(
      new Float64Array([0, 3]),
    );
    expect(h.store.log.filter((c) => c.kind === "read")).toHaveLength(2);
  });

  it("an op on a cache whose open waits for the chunk is held, then abandons the load", async () => {
    const h = hosted();
    h.store.seed("persist", fixture({}, [0, 3]));
    h.engine.cache(config());
    const opening = h.persistence.open("persist");
    const put = h.persistence.durably("persist", () =>
      h.engine.put("persist", batch([7])),
    );
    expect(put).toBeInstanceOf(Promise);
    expect(h.engine.coverage("persist", all)).toEqual([]);
    h.release();
    await opening;
    expect(await put).toEqual({ warnings: [] });
    // Memory is canonical (§4.10.5 rule 2): the stored points never load,
    // and the flush replaces the stored records with memory's.
    expect(h.engine.get("persist", all).timestamps).toEqual(
      new Float64Array([7]),
    );
    await h.persistence.persister?.flush();
    expect(h.store.records("persist")).toEqual(recordsOf(h.engine));
  });

  it("a removal held for the chunk answers once it is durable", async () => {
    const h = hosted();
    h.store.seed("persist", fixture({}, [0, 3]));
    h.engine.cache(config());
    const opening = h.persistence.open("persist");
    const write = h.store.gate("write");
    const invalidated = tracked(
      Promise.resolve(
        h.persistence.durably("persist", () =>
          h.engine.invalidate("persist", { start: 0, end: 0 }),
        ),
      ).then(() => undefined),
    );
    h.release();
    await opening;
    await write.entered;
    expect(invalidated.done).toBe(false);
    write.release();
    await invalidated.promise;
    expect(h.store.records("persist")).toEqual(recordsOf(h.engine));
  });

  it("ops on other caches run at once while the chunk loads", async () => {
    const h = hosted();
    h.engine.cache(config());
    h.engine.cache(plain);
    const opening = h.persistence.open("persist");
    const result = h.persistence.durably("plain", () =>
      h.engine.put("plain", batch([0])),
    );
    expect(result).toEqual({ warnings: [] });
    h.release();
    await opening;
  });

  it("once an op is held, later ops and clearAll wait behind it, in order", async () => {
    const h = hosted();
    h.engine.cache(config());
    h.engine.cache(plain);
    const opening = h.persistence.open("persist");
    const order: string[] = [];
    const first = h.persistence.durably("persist", () => {
      order.push("put persist");
      return h.engine.put("persist", batch([1]));
    });
    const cleared = h.persistence.clearAll();
    const second = h.persistence.durably("plain", () => {
      order.push("put plain");
      return h.engine.put("plain", batch([2]));
    });
    expect(order).toEqual([]);
    h.release();
    await Promise.all([opening, first, cleared, second]);
    expect(order).toEqual(["put persist", "put plain"]);
    // The clear ran between the two puts.
    expect(h.engine.coverage("persist", all)).toEqual([]);
    expect(h.engine.coverage("plain", all)).toEqual([{ start: 2, end: 2 }]);
  });

  it("clearAll before any open clears memory at once and loads the chunk to empty the disk", async () => {
    const h = hosted();
    h.store.seed("persist", fixture({}, [0, 3]));
    h.engine.cache(plain);
    h.engine.put("plain", batch([0]));
    const cleared = tracked(
      Promise.resolve(h.persistence.clearAll()).then(() => undefined),
    );
    expect(h.engine.coverage("plain", all)).toEqual([]);
    expect(h.load).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(cleared.done).toBe(false);
    h.release();
    await cleared.promise;
    expect(h.store.records("persist")).toEqual({ cache: undefined, pages: [] });
  });

  it("a clearAll while an open waits for the chunk: the cache starts cold and nothing stored loads", async () => {
    const h = hosted();
    h.store.seed("persist", fixture({}, [0, 3]));
    h.engine.cache(config());
    const opening = h.persistence.open("persist");
    const cleared = h.persistence.clearAll();
    h.release();
    await Promise.all([opening, cleared]);
    expect(h.engine.coverage("persist", all)).toEqual([]);
    expect(h.store.log.filter((c) => c.kind === "read")).toEqual([]);
    expect(h.store.records("persist")).toEqual({ cache: undefined, pages: [] });
  });

  it("a chunk that fails to load stops every waiting and later open with 'unavailable', once each", async () => {
    const h = hosted();
    h.engine.cache(config());
    h.engine.cache(config({ id: "later" }));
    const opening = h.persistence.open("persist");
    const put = h.persistence.durably("persist", () =>
      h.engine.put("persist", batch([1])),
    );
    h.fail(Object.assign(new Error("chunk 404"), { name: "TypeError" }));
    await opening;
    expect(await put).toEqual({ warnings: [] });
    await h.persistence.open("later");
    await h.persistence.open("persist");
    const error = { name: "TypeError", message: "chunk 404" };
    expect(h.stops).toEqual([
      { cacheId: "persist", reason: "unavailable", error },
      { cacheId: "later", reason: "unavailable", error },
    ]);
    expect(h.persistence.persister).toBeUndefined();
    // Persistence is off for the worker: ops run as they come, clearAll
    // clears memory only.
    expect(
      h.persistence.durably("persist", () =>
        h.engine.invalidate("persist", all),
      ),
    ).toBeUndefined();
    await h.persistence.clearAll();
    expect(h.load).toHaveBeenCalledTimes(1);
  });

  it("a chunk not loaded within timeoutMs turns persistence off; its late arrival is ignored", async () => {
    vi.useFakeTimers({ now: 0 });
    const h = hosted();
    h.engine.cache(config());
    const opening = tracked(h.persistence.open("persist"));
    await vi.advanceTimersByTimeAsync(4999);
    expect(opening.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await opening.promise;
    expect(h.stops).toEqual([{ cacheId: "persist", reason: "unavailable" }]);
    h.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.persistence.persister).toBeUndefined();
  });

  it("the import counts against the load's deadline", async () => {
    vi.useFakeTimers({ now: 0 });
    const h = hosted();
    h.engine.cache(config());
    const read = h.store.gate("read");
    const opening = tracked(h.persistence.open("persist"));
    await vi.advanceTimersByTimeAsync(3000);
    h.release();
    await read.entered;
    // 5 s from the open, not from the chunk's arrival.
    await vi.advanceTimersByTimeAsync(1999);
    expect(opening.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await opening.promise;
    expect(h.stops).toEqual([{ cacheId: "persist", reason: "unavailable" }]);
    read.release();
  });

  it("a flush waiting for the database to open writes no change made during a later clearAll (review round 9, R9-1)", async () => {
    vi.useFakeTimers({ now: 0 });
    const engine = new Engine();
    const store = new MemoryStore();
    const opening = deferred<MemoryStore>();
    const openStore = vi.fn((options?: { ifExists?: boolean }) =>
      options?.ifExists === true ? Promise.resolve(undefined) : opening.promise,
    );
    const stops: Stop[] = [];
    const persistence = new HostedPersistence(
      engine,
      async () => lazy,
      openStore,
      { onStopped: (event) => stops.push(event) },
    );
    // The first clearAll finds no database; a cache opened during its
    // barrier starts cold.
    const first = persistence.clearAll();
    engine.cache(config());
    const cold = persistence.open("persist");
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([first, cold]);
    expect(openStore.mock.calls).toEqual([[{ ifExists: true }]]);
    // Its flush, due after the quiet spell, waits for the database to open.
    await vi.advanceTimersByTimeAsync(1000);
    expect(openStore.mock.calls).toEqual([[{ ifExists: true }], []]);
    // A second clearAll begins; slot 0 is put during its barrier.
    const second = persistence.clearAll();
    await persistence.durably("persist", () =>
      engine.put("persist", batch([0])),
    );
    opening.resolve(store);
    await vi.advanceTimersByTimeAsync(0);
    await second;
    const flushed = (persistence.persister as Persister).flush();
    await vi.advanceTimersByTimeAsync(0);
    await flushed;
    expect(engine.coverage("persist", all)).toEqual([{ start: 0, end: 0 }]);
    // The attempt running at the second call wrote the state it took
    // before the call (the cold cache: nothing); the clear deleted it, and
    // the held put was written after the clear.
    expect(store.log.map((call) => call.kind)).toEqual([
      "write",
      "clearAll",
      "write",
    ]);
    expect(store.log[0]).toMatchObject({ plan: { putPages: [] } });
    expect(store.records("persist")).toEqual(recordsOf(engine));
    expect(stops).toEqual([]);
  });

  it("a flush while the chunk loads reaches the persister after the waiting opens", async () => {
    const h = hosted();
    h.engine.cache(config());
    const opening = h.persistence.open("persist");
    const put = h.persistence.durably("persist", () =>
      h.engine.put("persist", batch([4])),
    );
    h.persistence.flush();
    h.release();
    await Promise.all([opening, put]);
    await vi.waitFor(
      () => expect(h.store.records("persist")).toEqual(recordsOf(h.engine)),
      { timeout: 4000, interval: 1 },
    );
  });
});
