import { afterEach, describe, expect, it, vi } from "vitest";
import { Engine } from "../src/engine/engine";
import { createServer } from "../src/entries/worker";
import type { PersisterOptions } from "../src/persist/persister";
import type { PersistStore } from "../src/persist/store";
import { PortClient } from "../src/rpc/port-client";
import type { Evt, MessagePortLike } from "../src/rpc/protocol";
import { RpcServer } from "../src/rpc/server";
import type { GetResult, ResolvedCacheConfig } from "../src/types";
import { MemoryStore } from "./persist-memory-store";
import {
  allPages,
  batch,
  config,
  fixture,
  type PersistConfig,
  recordsOf,
  tracked,
} from "./persist-test-helpers";

// Implementer tests (architecture §4.10.8): the RPC server's persistence
// wiring over Node's MessageChannel, with the MemoryStore seam. Real
// timers: nothing here waits for time. Ordering is shown with store gates
// and with round trips on the same port, which are barriers: an answer
// posted before a later request's answer arrives before it.

const open: { dispose(): void }[] = [];
afterEach(() => {
  for (const item of open.splice(0)) item.dispose();
  delete (globalThis as { __tscPersistMeta?: unknown }).__tscPersistMeta;
});

/** A fetcher module: every slot of the range, value = t, with the meta the test sets. */
const fetcherModule = `data:text/javascript,${encodeURIComponent(`
  export default {
    async fetch(req) {
      const ts = [];
      for (let t = req.range.start; t <= req.range.end; t++) ts.push(t);
      const meta = globalThis.__tscPersistMeta;
      return { timestamps: ts, fields: { value: ts }, ...(meta ? { meta } : {}) };
    },
  };
`)}`;

/** A port to `server`, optionally with the fetcher, closed after the test. */
async function connect(
  server: RpcServer,
  withFetcher = false,
): Promise<{ client: PortClient; port: MessagePortLike; events: Evt[] }> {
  const channel = new MessageChannel();
  const port = channel.port1 as MessagePortLike;
  server.attach(port);
  const client = await PortClient.connect(
    channel.port2 as MessagePortLike,
    withFetcher ? { fetcher: { module: fetcherModule } } : {},
  );
  const events: Evt[] = [];
  client.on((evt) => events.push(evt));
  open.push(client, { dispose: () => server.detach(port) });
  return { client, port, events };
}

/** The SharedWorker's server over a MemoryStore, as entries/worker.ts builds it. */
function persisting(
  options: Omit<PersisterOptions, "onStopped"> = {},
  store = new MemoryStore(),
) {
  const openStore = vi.fn(async (): Promise<PersistStore> => store);
  const server = createServer(undefined, openStore, options);
  return { server, store, openStore };
}

/** A cache that is not persisted, for barrier round trips. */
const plain: PersistConfig = config({ id: "plain", persist: false });

/** A round trip on the client's port: everything posted before it has arrived. */
async function barrier(client: PortClient): Promise<void> {
  await client.request("cache", plain);
}

const until = (assertion: () => unknown) =>
  vi.waitFor(assertion, { timeout: 4000, interval: 1 });

/** Writes the persisted cache's data and waits until the store holds it. */
async function stored(
  client: PortClient,
  store: MemoryStore,
  cfg: PersistConfig = config(),
): Promise<void> {
  await client.request("cache", cfg);
  await client.request("put", { cacheId: cfg.id, batch: batch([0, 3, 7]) });
  await until(() => expect(store.records(cfg.id).pages).toHaveLength(2));
}

describe("persistence over RPC (§4.10.8)", () => {
  it("cache answers after the load, so a get right after reads the stored points", async () => {
    const { server, store } = persisting();
    store.seed("persist", fixture({}, [0, 3, 4]));
    const read = store.gate("read");
    const { client } = await connect(server);
    const opening = tracked(
      client.request("cache", config()).then(() => undefined),
    );
    await read.entered;
    await barrier(client);
    expect(opening.done).toBe(false);
    read.release();
    await opening.promise;
    const got = (await client.request("get", {
      cacheId: "persist",
      range: { start: 0, end: 4 },
      options: { cacheOnly: true },
    })) as GetResult;
    expect(got.timestamps).toEqual(new Float64Array([0, 3, 4]));
    expect(got.misses).toEqual([]);
  });

  it("two ports opening one cache read once, and both answer after that load", async () => {
    const { server, store, openStore } = persisting();
    store.seed("persist", fixture({}, [0]));
    const read = store.gate("read");
    const a = await connect(server);
    const b = await connect(server);
    const first = tracked(a.client.request("cache", config()).then(() => {}));
    await read.entered;
    const second = tracked(b.client.request("cache", config()).then(() => {}));
    await barrier(a.client);
    await barrier(b.client);
    expect(first.done || second.done).toBe(false);
    read.release();
    await Promise.all([first.promise, second.promise]);
    expect(store.log.filter((c) => c.kind === "read")).toHaveLength(1);
    expect(openStore).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["invalidate", { cacheId: "persist", range: { start: 3, end: 3 } }],
    ["clear", { cacheId: "persist" }],
    ["setFinalizedUntil", { cacheId: "persist", t: 2 }],
  ] as const)(
    "%s answers only once its removal is durable, through a failed first write",
    async (op, params) => {
      const { server, store } = persisting({ debounceMs: 1 });
      const { client } = await connect(server);
      await stored(client, store, config({ finalizedUntil: 20 }));
      const failing = store.gate("write");
      const retry = store.gate("write");
      const answer = tracked(client.request(op, params).then(() => {}));
      await failing.entered;
      failing.reject(
        Object.assign(new Error("disk"), { name: "UnknownError" }),
      );
      await retry.entered;
      await barrier(client);
      expect(answer.done).toBe(false);
      const writes = store.log.filter((c) => c.kind === "write");
      expect(writes.at(-1)).toMatchObject({ plan: { strict: true } });
      retry.release();
      await answer.promise;
      expect(
        store
          .records("persist")
          .pages.flatMap((p) => p.snapshot.coverage)
          .some((r) => r.start <= 3 && 3 <= r.end),
      ).toBe(false);
    },
  );

  it("clearAll answers only once the disk is empty, through a failed first attempt", async () => {
    const { server, store } = persisting({ debounceMs: 1 });
    const { client } = await connect(server);
    await stored(client, store);
    store.seed("unopened", fixture({ id: "unopened" }, [0]));
    const failing = store.gate("clearAll");
    const retry = store.gate("clearAll");
    const answer = tracked(client.request("clearAll", {}).then(() => {}));
    await failing.entered;
    failing.reject(Object.assign(new Error("disk"), { name: "UnknownError" }));
    await retry.entered;
    await barrier(client);
    expect(answer.done).toBe(false);
    retry.release();
    await answer.promise;
    expect(store.records("persist")).toEqual({ cache: undefined, pages: [] });
    expect(store.records("unopened")).toEqual({ cache: undefined, pages: [] });
  });

  it.each([
    ["a new version", { version: "v2" }, { version: "v1" }],
    ["a first watermark", { finalizedUntil: 5 }, {}],
  ] as const)(
    "a put whose data brings %s answers only once that removal is durable",
    async (_name, meta, creation) => {
      const { server, store } = persisting({ debounceMs: 1 });
      const { client } = await connect(server);
      await stored(client, store, config(creation));
      const write = store.gate("write");
      const answer = tracked(
        client
          .request("put", {
            cacheId: "persist",
            batch: { ...batch([1]), meta },
          })
          .then(() => {}),
      );
      await write.entered;
      await barrier(client);
      expect(answer.done).toBe(false);
      expect(store.log.at(-1)).toMatchObject({ plan: { strict: true } });
      write.release();
      await answer.promise;
    },
  );

  it.each([
    ["a new version", { version: "v2" }, { version: "v1" }],
    ["a first watermark", { finalizedUntil: 5 }, {}],
  ] as const)(
    "an orchestrated get whose fetch brings %s answers only once that removal is durable",
    async (_name, meta, creation) => {
      const { server, store } = persisting({ debounceMs: 1 });
      const { client } = await connect(server, true);
      await stored(client, store, config(creation));
      (globalThis as { __tscPersistMeta?: unknown }).__tscPersistMeta = meta;
      const write = store.gate("write");
      const answer = tracked(
        client
          .request("get", { cacheId: "persist", range: { start: 10, end: 12 } })
          .then(() => {}),
      );
      await write.entered;
      await barrier(client);
      expect(answer.done).toBe(false);
      expect(store.log.at(-1)).toMatchObject({ plan: { strict: true } });
      write.release();
      await answer.promise;
    },
  );

  it("a get or a put that removes nothing answers while a removal's write is held", async () => {
    const { server, store } = persisting({ debounceMs: 1 });
    const { client } = await connect(server);
    await stored(client, store);
    const write = store.gate("write");
    const removal = tracked(
      client
        .request("invalidate", {
          cacheId: "persist",
          range: { start: 7, end: 7 },
        })
        .then(() => {}),
    );
    await write.entered;
    await client.request("put", { cacheId: "persist", batch: batch([1]) });
    const got = (await client.request("get", {
      cacheId: "persist",
      range: { start: 0, end: 3 },
      options: { cacheOnly: true },
    })) as GetResult;
    expect(got.timestamps).toEqual(new Float64Array([0, 1, 3]));
    expect(removal.done).toBe(false);
    write.release();
    await removal.promise;
  });

  it("a raw clearAll while another port's cache() loads abandons the load; that cache() still answers", async () => {
    const { server, store } = persisting();
    store.seed("persist", fixture({}, [0, 3]));
    const read = store.gate("read");
    const a = await connect(server);
    const b = await connect(server);
    const opening = a.client.request("cache", config());
    await read.entered;
    await b.client.request("clearAll", {});
    await opening;
    read.release();
    const got = (await a.client.request("get", {
      cacheId: "persist",
      range: { start: 0, end: 3 },
      options: { cacheOnly: true },
    })) as GetResult;
    expect(got.timestamps).toEqual(new Float64Array());
    expect(got.coverage).toEqual([]);
    expect(store.records("persist")).toEqual({ cache: undefined, pages: [] });
  });

  it("the last connection's dispose flushes what the debounce still holds", async () => {
    const { server, store } = persisting({ debounceMs: 60_000 });
    const a = await connect(server);
    const b = await connect(server);
    await a.client.request("cache", config());
    await a.client.request("put", { cacheId: "persist", batch: batch([0]) });
    server.detach(a.port);
    await barrier(b.client);
    expect(store.log.filter((c) => c.kind === "write")).toEqual([]);
    server.detach(b.port);
    await until(() => expect(store.records("persist").pages).toHaveLength(1));
    const engine = new Engine();
    engine.cache(config());
    engine.put("persist", batch([0]));
    expect(store.records("persist")).toEqual(recordsOf(engine));
  });

  it("persistStopped reaches every port as a cache-scoped event", async () => {
    const failure = new DOMException("denied", "SecurityError");
    const server = createServer(undefined, async () => {
      throw failure;
    });
    const a = await connect(server);
    const b = await connect(server);
    await a.client.request("cache", config());
    const expected = {
      t: "evt",
      scope: "cache",
      cacheId: "persist",
      event: "persistStopped",
      payload: {
        cacheId: "persist",
        reason: "unavailable",
        error: { name: "SecurityError", message: "denied" },
      },
    };
    // Posted before the cache answer on a's port; b's comes in order too.
    expect(a.events).toEqual([expected]);
    await barrier(b.client);
    expect(b.events).toEqual([expected]);
  });

  it("a quota error stops the cache: persistStopped 'quota-exceeded' reaches the port and its records go", async () => {
    const { server, store } = persisting({ debounceMs: 1 });
    store.seed("persist", fixture());
    const a = await connect(server);
    await a.client.request("cache", config());
    store.fail("write", 1, "QuotaExceededError", "quota exceeded");
    await a.client.request("put", { cacheId: "persist", batch: batch([0]) });
    await until(() =>
      expect(a.events).toEqual([
        {
          t: "evt",
          scope: "cache",
          cacheId: "persist",
          event: "persistStopped",
          payload: {
            cacheId: "persist",
            reason: "quota-exceeded",
            error: { name: "QuotaExceededError", message: "quota exceeded" },
          },
        },
      ]),
    );
    await until(() =>
      expect(store.records("persist")).toEqual({ cache: undefined, pages: [] }),
    );
    const writes = store.log.filter((c) => c.kind === "write");
    expect(writes).toHaveLength(2);
    expect(writes[1]).toMatchObject({
      plan: { deletePages: allPages, putPages: [], putCache: null },
    });
  });

  it("a cache that is not persisted never touches the store", async () => {
    const { server, store, openStore } = persisting({ debounceMs: 1 });
    const { client } = await connect(server);
    const cfg = config({ persist: false });
    await client.request("cache", cfg);
    await client.request("put", { cacheId: "persist", batch: batch([0, 3]) });
    await client.request("invalidate", {
      cacheId: "persist",
      range: { start: 3, end: 3 },
    });
    await client.request("setFinalizedUntil", { cacheId: "persist", t: 2 });
    await client.request("clear", { cacheId: "persist" });
    await client.request("get", {
      cacheId: "persist",
      range: { start: 0, end: 3 },
      options: { cacheOnly: true },
    });
    expect(openStore).not.toHaveBeenCalled();
    expect(store.log).toEqual([]);
  });

  it("a server without a persister answers cache of a persisted cache at once and every op as before", async () => {
    const server = new RpcServer(new Engine(), "0.0.0");
    const { client, events } = await connect(server);
    const resolved = (await client.request(
      "cache",
      config(),
    )) as ResolvedCacheConfig;
    expect(resolved.persist).toBe(true);
    await client.request("put", { cacheId: "persist", batch: batch([0, 3]) });
    await client.request("invalidate", {
      cacheId: "persist",
      range: { start: 3, end: 3 },
    });
    const got = (await client.request("get", {
      cacheId: "persist",
      range: { start: 0, end: 3 },
      options: { cacheOnly: true },
    })) as GetResult;
    expect(got.coverage).toEqual([{ start: 0, end: 2 }]);
    await client.request("clear", { cacheId: "persist" });
    await client.request("clearAll", {});
    await barrier(client);
    expect(events.map((e) => e.event)).toEqual([
      "cacheCleared",
      "cacheCleared",
    ]);
  });

  it("the full rewrite after an abandoned load deletes every page", async () => {
    const { server, store } = persisting({ debounceMs: 1 });
    store.seed("persist", fixture({}, [0, 3, 4]));
    const read = store.gate("read");
    const a = await connect(server);
    const opening = a.client.request("cache", config());
    await read.entered;
    // A raw put by id, before any handle exists, abandons the load.
    await a.client.request("put", { cacheId: "persist", batch: batch([9]) });
    await opening;
    read.release();
    await until(() =>
      expect(store.log.filter((c) => c.kind === "write")).toHaveLength(1),
    );
    expect(store.log.at(-1)).toMatchObject({
      plan: { deletePages: allPages },
    });
  });
});
