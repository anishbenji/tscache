import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "../src/client/client";
import { openIdbStore } from "../src/persist/idb-store";
import { PortClient } from "../src/rpc/port-client";
import type { Evt, MessagePortLike } from "../src/rpc/protocol";
import type { ClientEvents, GetResult } from "../src/types";
import { batch, config } from "./persist-test-helpers";

// Implementer tests (architecture §4.10.1, §4.10.7, §4.10.8; N45, N52):
// only the SharedWorker hosting persists. The worker entry is loaded as each
// worker global would run it; IndexedDB is fake-indexeddb, or a stub that
// records every use.

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  vi.unstubAllGlobals();
});

const until = (assertion: () => unknown) =>
  vi.waitFor(assertion, { timeout: 4000, interval: 1 });

/** An `indexedDB` stand-in: reading any of its properties is a use, recorded. */
function recordingIndexedDB(): { uses: string[] } {
  const uses: string[] = [];
  const stub = new Proxy(
    {},
    {
      get(_target, key) {
        uses.push(String(key));
        return undefined;
      },
    },
  );
  vi.stubGlobal("indexedDB", stub);
  return { uses };
}

/** A connected client of `port`, with the events it receives. */
async function client(
  port: MessagePortLike,
): Promise<{ client: PortClient; events: Evt[] }> {
  const connected = await PortClient.connect(port);
  const events: Evt[] = [];
  connected.on((evt) => events.push(evt));
  cleanup.push(() => connected.dispose());
  return { client: connected, events };
}

/** Loads entries/worker.ts as a SharedWorker global runs it (no Web Locks). */
async function sharedWorker(): Promise<() => MessagePortLike> {
  const connect: ((event: { ports: MessagePortLike[] }) => void)[] = [];
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("importScripts", () => {});
  vi.stubGlobal("onconnect", null);
  vi.stubGlobal(
    "addEventListener",
    (type: string, fn: (event: { ports: MessagePortLike[] }) => void) => {
      if (type === "connect") connect.push(fn);
    },
  );
  vi.resetModules();
  await import("../src/entries/worker");
  return () => {
    const channel = new MessageChannel();
    cleanup.push(() => {
      channel.port1.close();
      channel.port2.close();
    });
    connect[0]?.({ ports: [channel.port1 as MessagePortLike] });
    return channel.port2 as MessagePortLike;
  };
}

/** Loads entries/worker.ts as a dedicated worker global runs it. */
async function dedicatedWorker(): Promise<MessagePortLike> {
  const channel = new MessageChannel();
  const port = channel.port1;
  cleanup.push(() => {
    channel.port1.close();
    channel.port2.close();
  });
  vi.stubGlobal("importScripts", () => {});
  vi.stubGlobal("postMessage", (message: unknown, transfer?: Transferable[]) =>
    port.postMessage(message, transfer ?? []),
  );
  vi.stubGlobal("addEventListener", (type: string, fn: EventListener) =>
    port.addEventListener(type, fn),
  );
  vi.stubGlobal("removeEventListener", (type: string, fn: EventListener) =>
    port.removeEventListener(type, fn),
  );
  vi.stubGlobal("start", () => port.start());
  vi.resetModules();
  await import("../src/entries/worker");
  return channel.port2 as MessagePortLike;
}

/** Every op on a persisted cache, then clearAll unless told not to. */
async function exercise(c: PortClient, clearAll = true): Promise<void> {
  await c.request("cache", config());
  await c.request("put", { cacheId: "persist", batch: batch([0, 3, 7]) });
  await c.request("get", {
    cacheId: "persist",
    range: { start: 0, end: 7 },
    options: { cacheOnly: true },
  });
  await c.request("invalidate", {
    cacheId: "persist",
    range: { start: 3, end: 3 },
  });
  await c.request("setFinalizedUntil", { cacheId: "persist", t: 5 });
  await c.request("clear", { cacheId: "persist" });
  if (clearAll) await c.request("clearAll", {});
}

/** Persists one page through a SharedWorker session over `factory`. */
async function persistThroughSharedWorker(factory: IDBFactory): Promise<void> {
  vi.stubGlobal("indexedDB", factory);
  const first = await client((await sharedWorker())());
  await first.client.request("cache", config());
  await first.client.request("put", {
    cacheId: "persist",
    batch: batch([0, 3]),
  });
  await first.client.request("dispose", {});
  await until(async () => {
    expect((await stored(factory)).pages).toHaveLength(1);
  });
  // The next hosting starts from a clean global scope, IndexedDB included.
  vi.unstubAllGlobals();
  vi.stubGlobal("indexedDB", factory);
}

/** What the database of `factory` holds for the persisted cache. */
async function stored(
  factory: IDBFactory,
): Promise<{ cache: unknown; pages: unknown[] }> {
  const store = await openIdbStore(factory, { ifExists: true });
  const records = (await store?.read("persist")) ?? {
    cache: undefined,
    pages: [],
  };
  store?.close();
  return records;
}

/** A new SharedWorker over `factory` reads nothing stored for the cache. */
async function expectNothingLoaded(factory: IDBFactory): Promise<void> {
  vi.unstubAllGlobals();
  vi.stubGlobal("indexedDB", factory);
  const next = await client((await sharedWorker())());
  await next.client.request("cache", config());
  const got = (await next.client.request("get", {
    cacheId: "persist",
    range: { start: 0, end: 3 },
    options: { cacheOnly: true },
  })) as GetResult;
  expect(got.timestamps).toEqual(new Float64Array([]));
}

/** An `indexedDB` whose every use fails, its uses counted. */
function failingIndexedDB(): { uses: string[] } {
  const uses: string[] = [];
  const fail = (key: string) => () => {
    uses.push(key);
    return Promise.reject(
      Object.assign(new Error("planted failure"), { name: "UnknownError" }),
    );
  };
  vi.stubGlobal("indexedDB", {
    databases: fail("databases"),
    open: () => {
      uses.push("open");
      throw Object.assign(new Error("planted failure"), {
        name: "UnknownError",
      });
    },
  });
  return { uses };
}

describe("which hosting persists (§4.10.8)", () => {
  it("the SharedWorker entry persists to IndexedDB, and a new worker loads it", async () => {
    const factory = new IDBFactory();
    vi.stubGlobal("indexedDB", factory);
    const first = await client((await sharedWorker())());
    await first.client.request("cache", config());
    await first.client.request("put", {
      cacheId: "persist",
      batch: batch([0, 3]),
    });
    // The last connection going flushes (§4.10.8).
    await first.client.request("dispose", {});
    await until(async () => {
      const store = await openIdbStore(factory, { ifExists: true });
      const records = await store?.read("persist");
      store?.close();
      expect(records?.pages).toHaveLength(1);
    });
    // A new worker of the same origin: a reload.
    const second = await client((await sharedWorker())());
    await second.client.request("cache", config());
    const got = (await second.client.request("get", {
      cacheId: "persist",
      range: { start: 0, end: 3 },
      options: { cacheOnly: true },
    })) as GetResult;
    expect(got.timestamps).toEqual(new Float64Array([0, 3]));
    expect(got.misses).toEqual([]);
  });

  it("the SharedWorker entry without IndexedDB answers as before and emits nothing", async () => {
    const connect = await sharedWorker();
    const { client: c, events } = await client(connect());
    await exercise(c);
    expect(events.map((e) => e.event)).not.toContain("persistStopped");
  });

  it("the dedicated entry persists nothing: no op but clearAll opens, reads or writes IndexedDB", async () => {
    const { uses } = recordingIndexedDB();
    const { client: c, events } = await client(await dedicatedWorker());
    await exercise(c, false);
    // The server drops the global "port" while its stubs are still in place.
    await c.request("dispose", {});
    expect(uses).toEqual([]);
    expect(events.map((e) => e.event)).not.toContain("persistStopped");
  });

  it("the in-process hosting persists nothing: no op but clearAll opens, reads or writes IndexedDB", async () => {
    const { uses } = recordingIndexedDB();
    const c = await createClient({ mode: "in-process" });
    cleanup.push(() => void c.dispose());
    const stopped: ClientEvents["persistStopped"][] = [];
    c.on("persistStopped", (e) => stopped.push(e));
    const handle = await c.cache(config());
    await handle.put(batch([0, 3, 7]));
    await handle.get({ start: 0, end: 7 });
    await handle.invalidate({ start: 3, end: 3 });
    await handle.setFinalizedUntil(5);
    await handle.clear();
    expect(c.mode).toBe("in-process");
    expect(uses).toEqual([]);
    expect(stopped).toEqual([]);
  });
});

describe("clearAll in the hostings that do not persist (§4.10.7, N66)", () => {
  it("a dedicated client's clearAll empties what a SharedWorker session stored; the next SharedWorker loads nothing", async () => {
    const factory = new IDBFactory();
    await persistThroughSharedWorker(factory);
    const { client: c, events } = await client(await dedicatedWorker());
    await c.request("cache", config());
    await c.request("put", { cacheId: "persist", batch: batch([7]) });
    await c.request("clearAll", {});
    expect(await stored(factory)).toEqual({ cache: undefined, pages: [] });
    expect(events.map((e) => e.event)).not.toContain("persistStopped");
    await c.request("dispose", {});
    await expectNothingLoaded(factory);
  });

  it("an in-process client's clearAll empties what a SharedWorker session stored; the next SharedWorker loads nothing", async () => {
    const factory = new IDBFactory();
    await persistThroughSharedWorker(factory);
    const c = await createClient({ mode: "in-process" });
    cleanup.push(() => void c.dispose());
    const stopped: ClientEvents["persistStopped"][] = [];
    c.on("persistStopped", (e) => stopped.push(e));
    await c.clearAll();
    expect(c.mode).toBe("in-process");
    expect(await stored(factory)).toEqual({ cache: undefined, pages: [] });
    expect(stopped).toEqual([]);
    await expectNothingLoaded(factory);
  });

  it("without a database, clearAll from either hosting creates none", async () => {
    const factory = new IDBFactory();
    vi.stubGlobal("indexedDB", factory);
    const c = await createClient({ mode: "in-process" });
    cleanup.push(() => void c.dispose());
    await c.clearAll();
    const { client: d } = await client(await dedicatedWorker());
    await d.request("clearAll", {});
    await d.request("dispose", {});
    expect(await factory.databases()).toEqual([]);
  });

  it("an IndexedDB that fails: clearAll still answers, memory cleared, nothing emitted, and the next clearAll tries again", async () => {
    const { uses } = failingIndexedDB();
    const { client: d, events } = await client(await dedicatedWorker());
    await d.request("cache", config());
    await d.request("put", { cacheId: "persist", batch: batch([0, 3]) });
    await d.request("clearAll", {});
    const got = (await d.request("get", {
      cacheId: "persist",
      range: { start: 0, end: 3 },
      options: { cacheOnly: true },
    })) as GetResult;
    expect(got.timestamps).toEqual(new Float64Array([]));
    expect(uses).toEqual(["databases"]);
    await d.request("clearAll", {});
    expect(uses).toEqual(["databases", "databases"]);
    expect(events.map((e) => e.event)).not.toContain("persistStopped");
    await d.request("dispose", {});

    const c = await createClient({ mode: "in-process" });
    cleanup.push(() => void c.dispose());
    const stopped: ClientEvents["persistStopped"][] = [];
    c.on("persistStopped", (e) => stopped.push(e));
    await c.clearAll();
    await c.clearAll();
    expect(uses).toEqual(["databases", "databases", "databases", "databases"]);
    expect(stopped).toEqual([]);
  });
});
