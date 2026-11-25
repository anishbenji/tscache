import { afterEach, describe, expect, it, vi } from "vitest";
import { Engine } from "../src/engine/engine";
import { HostedPersistence, type LazyPersist } from "../src/persist/hosted";
import * as lazy from "../src/persist/lazy";
import type { Persister } from "../src/persist/persister";
import type { PersistStore } from "../src/persist/store";
import type { ClientEvents } from "../src/types";
import { writes } from "./persist-harness";
import { deferred, MemoryStore } from "./persist-memory-store";
import {
  all,
  batch,
  config,
  expectRecords,
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
    // Persistence is off for the worker: ops run as they come. A cache's
    // first removal runs the cleanup its stop deferred, through the store
    // opener, and answers once that settled (user decision 113 A); a later
    // removal answers at once. clearAll empties the whole store once, and that
    // clear is the cleanup of every cache its engine clear removed from (user
    // decision 123 A).
    const removal = h.persistence.durably("persist", () =>
      h.engine.invalidate("persist", all),
    );
    expect(removal).toBeInstanceOf(Promise);
    expect(await removal).toBeUndefined();
    expect(
      h.persistence.durably("persist", () =>
        h.engine.invalidate("persist", all),
      ),
    ).toBeUndefined();
    await h.persistence.clearAll();
    const cleanup = {
      deletePages: [{ start: -Infinity, end: Infinity }],
      putPages: [],
      putCache: null,
      strict: true,
    };
    expect(writes(h.store)).toMatchObject([
      { cacheId: "persist", settled: true, plan: cleanup },
    ]);
    expect(h.store.log.at(-1)?.kind).toBe("clearAll");
    expect(h.load).toHaveBeenCalledTimes(1);
  });

  // Security lane 2 of step 132 (S2.1), from its reproduction: an op whose
  // removal comes after an await, as a get whose fetch brings a new version
  // does, answers once the deferred cleanup settled (user decision 113 A).
  it("after a chunk failure, an op whose removal comes after an await answers once the cleanup settled", async () => {
    vi.useFakeTimers({ now: 0 });
    const h = hosted();
    const seeded = fixture();
    h.store.seed("persist", seeded);
    h.engine.cache(config());
    const opening = h.persistence.open("persist");
    h.fail(new Error("chunk 404"));
    await opening;
    const cleanup = h.store.gate("write");
    const answer = tracked(
      Promise.resolve(
        h.persistence.durably("persist", async () => {
          await Promise.resolve();
          h.engine.invalidate("persist", all);
        }),
      ).then(() => undefined),
    );
    await cleanup.entered;
    await vi.advanceTimersByTimeAsync(0);
    expect(answer.done).toBe(false);
    expect(h.store.records("persist")).toEqual(seeded);
    cleanup.release();
    await answer.promise;
    expect(h.store.records("persist")).toEqual({ cache: undefined, pages: [] });
  });

  it("a chunk import timeout turns persistence off and keeps records for the next session", async () => {
    vi.useFakeTimers({ now: 0 });
    const h = hosted();
    const seeded = fixture();
    h.store.seed("persist", seeded);
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
    expect(h.store.records("persist")).toEqual(seeded);
    const next = hosted(h.store);
    next.engine.cache(config());
    const reloaded = next.persistence.open("persist");
    next.release();
    await reloaded;
    expectRecords(seeded, next.engine);
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

// Implementer tests, written before the code (user decision 123 A; Codex
// is limited to gate rounds, docs/reviews/step-132.md): after a chunk
// failure, clearAll also empties the whole store once through the store
// opener, bounded by timeoutMs, its failure ignored.
describe("clearAll after a chunk failure (user decision 123 A)", () => {
  /**
   * A hosting whose chunk failed at the open of `stopped`, over
   * `openStore`; the engine holds `persist` and `mem`, which does not
   * persist.
   */
  async function failedWith(
    openStore: (options?: {
      ifExists?: boolean;
    }) => Promise<MemoryStore | undefined>,
    stopped = "persist",
  ) {
    const engine = new Engine();
    const open = vi.fn(openStore);
    const persistence = new HostedPersistence(
      engine,
      () => Promise.reject(new TypeError("chunk 404")),
      open,
    );
    engine.cache(config());
    engine.cache(config({ id: "mem", persist: false }));
    await persistence.open(stopped);
    return { engine, open, persistence };
  }

  it("empties a never-opened cache's records, the opened cache's cleanup absorbed", async () => {
    vi.useFakeTimers({ now: 0 });
    const store = new MemoryStore();
    store.seed("persist", fixture({}, [0, 4]));
    store.seed("never", fixture({ id: "never" }, [0, 4]));
    const h = await failedWith(async () => store);
    await h.persistence.clearAll();
    const empty = { cache: undefined, pages: [] };
    expect(store.records("never")).toEqual(empty);
    expect(store.records("persist")).toEqual(empty);
    expect(writes(store)).toEqual([]);
    expect(h.open.mock.calls).toEqual([[{ ifExists: true }]]);
  });

  it("resolves at timeoutMs when the store opener hangs", async () => {
    vi.useFakeTimers({ now: 0 });
    // The stopped cache is not the engine's, so no deferred cleanup runs:
    // only the whole-store clear reaches the opener.
    const h = await failedWith(() => new Promise(() => {}), "gone");
    h.engine.put("mem", batch([1]));
    const cleared = tracked(
      Promise.resolve(h.persistence.clearAll()).then(() => undefined),
    );
    await vi.advanceTimersByTimeAsync(4999);
    expect(cleared.done).toBe(false);
    expect(h.open.mock.calls).toEqual([[{ ifExists: true }]]);
    await vi.advanceTimersByTimeAsync(1);
    expect(cleared.done).toBe(true);
    expect(h.engine.coverage("mem", all)).toEqual([]);
  });

  it("resolves with memory cleared when the store opener rejects", async () => {
    vi.useFakeTimers({ now: 0 });
    const h = await failedWith(
      () => Promise.reject(new DOMException("open failed", "UnknownError")),
      "gone",
    );
    h.engine.put("mem", batch([1]));
    await h.persistence.clearAll();
    expect(h.open.mock.calls).toEqual([[{ ifExists: true }]]);
    expect(h.engine.coverage("mem", all)).toEqual([]);
  });

  // Codex gate round 2, R2-2: the twin of the case above with an opener
  // that throws synchronously; the throw is the opening's rejection.
  it("resolves with memory cleared when the store opener throws", async () => {
    vi.useFakeTimers({ now: 0 });
    const h = await failedWith(() => {
      throw new DOMException("open failed", "SecurityError");
    }, "gone");
    h.engine.put("mem", batch([1]));
    await h.persistence.clearAll();
    expect(h.open.mock.calls).toEqual([[{ ifExists: true }]]);
    expect(h.engine.coverage("mem", all)).toEqual([]);
  });

  it("answers a removal whose cleanup's store opener throws, the removal applied", async () => {
    vi.useFakeTimers({ now: 0 });
    const h = await failedWith(() => {
      throw new DOMException("open failed", "SecurityError");
    });
    h.engine.put("persist", batch([1, 2]));
    const removal = h.persistence.durably("persist", () =>
      h.engine.invalidate("persist", all),
    );
    expect(removal).toBeInstanceOf(Promise);
    await removal;
    expect(h.open.mock.calls).toEqual([[{ ifExists: true }]]);
    expect(h.engine.coverage("persist", all)).toEqual([]);
  });

  // The class map of step 132: cleanups started before the call are waited
  // for, and the whole-store clear is the cleanup of every cache its engine
  // clear reached, so a later removal waits for nothing (§4.10.8).
  it("waits for a cleanup started before the call", async () => {
    vi.useFakeTimers({ now: 0 });
    const store = new MemoryStore();
    store.seed("persist", fixture({}, [0, 4]));
    const h = await failedWith(async () => store);
    const cleanup = store.gate("write");
    const removal = h.persistence.durably("persist", () =>
      h.engine.invalidate("persist", all),
    );
    await cleanup.entered;
    const cleared = tracked(
      Promise.resolve(h.persistence.clearAll()).then(() => undefined),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(store.log.at(-1)?.kind).toBe("clearAll");
    expect(cleared.done).toBe(false);
    cleanup.release();
    await Promise.all([removal, cleared.promise]);
    expect(store.records("persist")).toEqual({ cache: undefined, pages: [] });
  });

  it("starts no cleanup for a removal after a whole-store clear that failed", async () => {
    vi.useFakeTimers({ now: 0 });
    const h = await failedWith(() =>
      Promise.reject(new DOMException("open failed", "UnknownError")),
    );
    await h.persistence.clearAll();
    expect(
      h.persistence.durably("persist", () =>
        h.engine.invalidate("persist", all),
      ),
    ).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.open.mock.calls).toEqual([[{ ifExists: true }]]);
  });

  // Codex gate round 1, R1-2: a store that opens after the deadline is
  // still emptied, after the call has answered (§4.10.8).
  it("empties the store when its opening resolves after clearAll answered", async () => {
    vi.useFakeTimers({ now: 0 });
    const store = new MemoryStore();
    const seeded = fixture({ id: "never" }, [0, 4]);
    store.seed("never", seeded);
    const opening = deferred<MemoryStore | undefined>();
    const h = await failedWith(() => opening.promise, "gone");
    const cleared = tracked(
      Promise.resolve(h.persistence.clearAll()).then(() => undefined),
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(cleared.done).toBe(true);
    expect(store.records("never")).toEqual(seeded);
    opening.resolve(store);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.records("never")).toEqual({ cache: undefined, pages: [] });
  });

  it("deletes a cache's records when the cleanup's opening resolves after its removal answered", async () => {
    vi.useFakeTimers({ now: 0 });
    const store = new MemoryStore();
    const seeded = fixture({}, [0, 4]);
    store.seed("persist", seeded);
    const opening = deferred<MemoryStore | undefined>();
    const h = await failedWith(() => opening.promise);
    const removal = tracked(
      Promise.resolve(
        h.persistence.durably("persist", () =>
          h.engine.invalidate("persist", all),
        ),
      ).then(() => undefined),
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(removal.done).toBe(true);
    expect(store.records("persist")).toEqual(seeded);
    opening.resolve(store);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.records("persist")).toEqual({ cache: undefined, pages: [] });
  });

  // Codex gate round 4, R4-2: a logout that found no database looks again at
  // the next one, since another worker may have created it meanwhile.
  it("opens the store again at a later clearAll when an earlier one found no database", async () => {
    vi.useFakeTimers({ now: 0 });
    const store = new MemoryStore();
    let created = false;
    const h = await failedWith(
      async () => (created ? store : undefined),
      "gone",
    );
    await h.persistence.clearAll();
    store.seed("never", fixture({ id: "never" }, [0, 4]));
    created = true;
    await h.persistence.clearAll();
    expect(h.open.mock.calls).toEqual([
      [{ ifExists: true }],
      [{ ifExists: true }],
    ]);
    expect(store.log.map((call) => call.kind)).toEqual(["clearAll"]);
    expect(store.records("never")).toEqual({ cache: undefined, pages: [] });
  });

  it("empties the store when the clearAll's own import of the chunk fails", async () => {
    vi.useFakeTimers({ now: 0 });
    const h = hosted();
    h.store.seed("never", fixture({ id: "never" }, [0, 4]));
    const cleared = h.persistence.clearAll();
    h.fail(new TypeError("chunk 404"));
    await cleared;
    expect(h.store.records("never")).toEqual({ cache: undefined, pages: [] });
  });
});

// Codex gate round 2, R2-3: after a chunk failure, an op that fails after
// recording a removal answers with its own error, and only once the deferred
// cleanup settled (N58, user decision 113 A, §4.10.8).
describe("an op that fails after its removal, the chunk failed", () => {
  async function stoppedOver(store: MemoryStore) {
    const engine = new Engine();
    const persistence = new HostedPersistence(
      engine,
      () => Promise.reject(new TypeError("chunk 404")),
      async () => store,
    );
    engine.cache(config());
    await persistence.open("persist");
    return { engine, persistence };
  }

  it.each(["throws", "rejects"])(
    "%s with its error once the gated cleanup settled",
    async (failure) => {
      vi.useFakeTimers({ now: 0 });
      const store = new MemoryStore();
      store.seed("persist", fixture());
      const h = await stoppedOver(store);
      const cleanup = store.gate("write");
      const boom = new Error("listener");
      const op =
        failure === "throws"
          ? () => {
              h.engine.invalidate("persist", all);
              throw boom;
            }
          : async () => {
              await Promise.resolve();
              h.engine.invalidate("persist", all);
              throw boom;
            };
      let outcome: unknown = "pending";
      Promise.resolve(h.persistence.durably("persist", op)).then(
        () => {
          outcome = "resolved";
        },
        (error: unknown) => {
          outcome = error;
        },
      );
      await cleanup.entered;
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBe("pending");
      cleanup.release();
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBe(boom);
      expect(store.records("persist")).toEqual({ cache: undefined, pages: [] });
    },
  );
});

// Codex gate round 4, R4-3: a chunk loader that throws is an import that
// failed: the calls waiting for it take the failure path (§4.10.8).
describe("a chunk loader that throws", () => {
  function throwing() {
    const store = new MemoryStore();
    store.seed("never", fixture({ id: "never" }, [0, 4]));
    const engine = new Engine();
    const open = vi.fn(async (_options?: { ifExists?: boolean }) => store);
    const stops: Stop[] = [];
    const persistence = new HostedPersistence(
      engine,
      () => {
        throw new TypeError("no chunk");
      },
      open,
      { onStopped: (event) => stops.push(event) },
    );
    engine.cache(config());
    return { store, open, stops, persistence };
  }
  const error = { name: "TypeError", message: "no chunk" };

  it("a first clearAll answers, the whole store emptied through the store opener", async () => {
    vi.useFakeTimers({ now: 0 });
    const h = throwing();
    const cleared = h.persistence.clearAll();
    expect(cleared).toBeInstanceOf(Promise);
    await cleared;
    expect(h.open.mock.calls).toEqual([[{ ifExists: true }]]);
    expect(h.store.log.map((call) => call.kind)).toEqual(["clearAll"]);
    expect(h.store.records("never")).toEqual({ cache: undefined, pages: [] });
    await h.persistence.open("persist");
    expect(h.stops).toEqual([
      { cacheId: "persist", reason: "unavailable", error },
    ]);
  });

  it("a first open answers and stops the cache with 'unavailable' and the error", async () => {
    vi.useFakeTimers({ now: 0 });
    const h = throwing();
    const opening = h.persistence.open("persist");
    expect(opening).toBeInstanceOf(Promise);
    await opening;
    expect(h.stops).toEqual([
      { cacheId: "persist", reason: "unavailable", error },
    ]);
    expect(h.open).not.toHaveBeenCalled();
  });
});

// Codex gate round 4, R4-1: the calls made while the chunk loads take effect
// in the order they arrived, so an order in which the import fails leaves the
// store as the same calls made after the failure do (§4.10.8). Here a logout
// waits behind a held removal of A, and B is opened after the logout: the
// whole-store clear is not B's cleanup, and B's first removal deletes its
// records, whether the clear failed or not.
describe("calls held for a chunk that fails take effect in arrival order", () => {
  async function sixCalls(failFirst: boolean, clear: "ok" | "fail") {
    vi.useFakeTimers({ now: 0 });
    const store = new MemoryStore();
    store.seed("A", fixture({ id: "A" }, [0, 4]));
    store.seed("B", fixture({ id: "B" }, [0, 4]));
    if (clear === "fail") store.fail("clearAll");
    const engine = new Engine();
    const chunk = deferred<LazyPersist>();
    const persistence = new HostedPersistence(
      engine,
      () => chunk.promise,
      async () => store,
    );
    const failure = new TypeError("chunk 404");
    if (failFirst) {
      chunk.reject(failure);
      await persistence.open("gone");
    }
    const answers: Promise<unknown>[] = [];
    engine.cache(config({ id: "A" }));
    answers.push(Promise.resolve(persistence.open("A")));
    answers.push(
      Promise.resolve(persistence.durably("A", () => engine.clear("A"))).catch(
        () => {},
      ),
    );
    answers.push(Promise.resolve(persistence.clearAll()).catch(() => {}));
    engine.cache(config({ id: "B" }));
    answers.push(Promise.resolve(persistence.open("B")));
    if (!failFirst) chunk.reject(failure);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all(answers);
    const afterLogout = store.records("B");
    await persistence.durably("B", () => engine.invalidate("B", all));
    const log = store.log.map((call) =>
      call.kind === "clearAll" ? call.kind : `${call.kind}:${call.cacheId}`,
    );
    return { log, afterLogout, after: store.records("B") };
  }

  it.each(["ok", "fail"] as const)(
    "a held logout, then B opened, then the failure (store clear %s)",
    async (clear) => {
      const held = await sixCalls(false, clear);
      expect(held).toEqual(await sixCalls(true, clear));
      expect(held.log).toEqual(["write:A", "clearAll", "write:B"]);
      expect(held.after).toEqual({ cache: undefined, pages: [] });
    },
  );
});

// Codex gate round 5, R5-2: two logouts made while the chunk loads, which
// then fails. The first one's whole-store clear is the opened cache's
// cleanup; the second waits for it as the same calls made after the failure
// do, even when its own store clear fails at once (§4.10.8 arrival order).
describe("a second logout held for a chunk that fails (Codex gate round 5, R5-2)", () => {
  async function twoLogouts(failFirst: boolean) {
    vi.useFakeTimers({ now: 0 });
    const memory = new MemoryStore();
    memory.seed("A", fixture({ id: "A" }, [0, 4]));
    const first = deferred<void>();
    let clears = 0;
    const store: PersistStore = {
      read: (cacheId, pages) => memory.read(cacheId, pages),
      write: (cacheId, plan) => memory.write(cacheId, plan),
      clearAll: () => {
        clears++;
        if (clears === 1) return first.promise.then(() => memory.clearAll());
        return Promise.reject(new DOMException("closed", "InvalidStateError"));
      },
      close: () => memory.close(),
    };
    const engine = new Engine();
    const chunk = deferred<LazyPersist>();
    const persistence = new HostedPersistence(
      engine,
      () => chunk.promise,
      async () => store,
    );
    engine.cache(config({ id: "A" }));
    const opening = tracked(persistence.open("A"));
    const failure = new TypeError("chunk 404");
    if (failFirst) {
      chunk.reject(failure);
      await vi.advanceTimersByTimeAsync(0);
    }
    const logouts = [
      tracked(Promise.resolve(persistence.clearAll()).then(() => undefined)),
      tracked(Promise.resolve(persistence.clearAll()).then(() => undefined)),
    ];
    if (!failFirst) chunk.reject(failure);
    await vi.advanceTimersByTimeAsync(10);
    return { memory, first, opening, logouts, clears: () => clears };
  }

  it.each([false, true])(
    "the second waits for the first's gated clear (failure first: %s)",
    async (failFirst) => {
      const h = await twoLogouts(failFirst);
      expect(h.opening.done).toBe(true);
      expect(h.clears()).toBe(2);
      expect(h.logouts.map((logout) => logout.done)).toEqual([false, false]);
      expect(h.memory.records("A").pages).toHaveLength(2);
      h.first.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.logouts.map((logout) => logout.done)).toEqual([true, true]);
      expect(h.memory.records("A")).toEqual({ cache: undefined, pages: [] });
    },
  );
});

// Codex gate round 5, R5-3: a chunk loader that throws, or rejects with, a
// value that cannot be turned into a string still fails the import: the
// calls waiting for it take the failure path (§4.10.8).
describe("a chunk loader failing with a value without a string form (Codex gate round 5, R5-3)", () => {
  function failing(form: "throws" | "rejects") {
    const store = new MemoryStore();
    store.seed("never", fixture({ id: "never" }, [0, 4]));
    const engine = new Engine();
    const open = vi.fn(async (_options?: { ifExists?: boolean }) => store);
    const stops: Stop[] = [];
    const persistence = new HostedPersistence(
      engine,
      () => {
        if (form === "throws") throw Object.create(null);
        return Promise.reject(Object.create(null));
      },
      open,
      { onStopped: (event) => stops.push(event) },
    );
    engine.cache(config());
    return { store, open, stops, persistence };
  }
  const error = { name: "Error", message: "Error" };

  it.each(["throws", "rejects"] as const)(
    "a first open answers and reports 'unavailable' (loader %s)",
    async (form) => {
      vi.useFakeTimers({ now: 0 });
      const h = failing(form);
      const opening = tracked(h.persistence.open("persist"));
      await vi.advanceTimersByTimeAsync(0);
      expect(opening.done).toBe(true);
      expect(h.stops).toEqual([
        { cacheId: "persist", reason: "unavailable", error },
      ]);
      expect(h.open).not.toHaveBeenCalled();
    },
  );

  it.each(["throws", "rejects"] as const)(
    "a first clearAll answers with one ifExists opener call (loader %s)",
    async (form) => {
      vi.useFakeTimers({ now: 0 });
      const h = failing(form);
      const cleared = tracked(
        Promise.resolve(h.persistence.clearAll()).then(() => undefined),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(cleared.done).toBe(true);
      expect(h.open.mock.calls).toEqual([[{ ifExists: true }]]);
      expect(h.store.records("never")).toEqual({ cache: undefined, pages: [] });
    },
  );
});
