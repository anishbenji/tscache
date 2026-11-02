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

/** Every op on a persisted cache, then clearAll. */
async function exercise(c: PortClient): Promise<void> {
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
  await c.request("clearAll", {});
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

  it("the dedicated entry builds no persister: nothing opened, read, written or cleared", async () => {
    const { uses } = recordingIndexedDB();
    const { client: c, events } = await client(await dedicatedWorker());
    await exercise(c);
    // The server drops the global "port" while its stubs are still in place.
    await c.request("dispose", {});
    expect(uses).toEqual([]);
    expect(events.map((e) => e.event)).not.toContain("persistStopped");
  });

  it("the in-process hosting builds no persister: nothing opened, read, written or cleared", async () => {
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
    await c.clearAll();
    expect(c.mode).toBe("in-process");
    expect(uses).toEqual([]);
    expect(stopped).toEqual([]);
  });
});
