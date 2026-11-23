import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient, type TscacheClient } from "../src/client/client";
import { ClientEmitter } from "../src/client/events";
import { Engine } from "../src/engine/engine";
import { createServer } from "../src/entries/worker";
import { ConfigError } from "../src/errors";
import { HostedPersistence } from "../src/persist/hosted";
import * as lazy from "../src/persist/lazy";
import { PortClient } from "../src/rpc/port-client";
import {
  type Evt,
  fromWireError,
  LIB_VERSION,
  type MessagePortLike,
  PROTOCOL_VERSION,
  type WireError,
} from "../src/rpc/protocol";
import { RpcServer } from "../src/rpc/server";
import type { CacheConfig, MemoryStats } from "../src/types";
import { PAGE_BYTES } from "./m3-memory-helpers";
import { deferred, MemoryStore } from "./persist-memory-store";
import { batch, config, fixture, tracked } from "./persist-test-helpers";
import { fakeChannels } from "./workers-channel";

// Implementer tests for deploy skew over the RPC layer, the hostings and the
// client (docs/design/m5-deploy-skew.md §6 tests 13, 15-17, 31, 32 and 36;
// architecture §2.7, §4.7, §4.8, §4.10.7; N125, N129, N132, N135, N136,
// N141). Tests 29 and 30 are in files of their own (decision concerns DC2
// and DC4). Real timers: nothing here waits for time. An absence is shown by
// a round trip on the same port, which arrives after everything the server
// posted before it (docs/testing.md, Waiting).

type Bus = ReturnType<typeof fakeChannels>;
/** What a SharedWorker's server is told of itself (entries/worker.ts). */
type SharedIdentity = NonNullable<Parameters<typeof createServer>[4]>;

const workerUrl = "https://app.example/dist/worker.js";
const open: { dispose(): unknown }[] = [];

afterEach(async () => {
  for (const item of open.splice(0)) await item.dispose();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** A fetcher module: every slot of the range, value = t. */
const fetcherModule = (tag: string) =>
  `data:text/javascript,${encodeURIComponent(`
    export default {
      async fetch(req) {
        const ts = [];
        for (let t = req.range.start; t <= req.range.end; t += req.interval) ts.push(t);
        return { timestamps: ts, fields: { value: ts } };
      },
    }; // ${tag}
  `)}`;
const moduleA = fetcherModule("a");
const moduleB = fetcherModule("b");

const plain: CacheConfig = config({ id: "plain", persist: false });

/** A SharedWorker's server on the bus, as entries/worker.ts builds it. */
function shared(
  bus: Bus,
  identity: Partial<Omit<SharedIdentity, "channel">> = {},
  // `null`: a realm without IndexedDB, so a server without persistence.
  store: MemoryStore | null = new MemoryStore(),
) {
  const server = createServer(
    undefined,
    store === null ? undefined : async () => store,
    undefined,
    false,
    { channel: bus.open(), url: workerUrl, startedAt: 1, ...identity },
  );
  return { server, store };
}

/** A connected port of `server`, with the events it receives. */
async function connect(server: RpcServer, module?: string) {
  const channel = new MessageChannel();
  const port = channel.port1 as MessagePortLike;
  server.attach(port);
  const client = await PortClient.connect(
    channel.port2 as MessagePortLike,
    module === undefined ? {} : { fetcher: { module } },
  );
  const events: Evt[] = [];
  client.on((evt) => events.push(evt));
  open.push(client, { dispose: () => server.detach(port) });
  return { client, events };
}

/** A round trip: everything the server posted before it has arrived. */
async function barrier(client: PortClient): Promise<void> {
  await client.request("cache", plain);
}

async function make(
  options: Parameters<typeof createClient>[0],
): Promise<TscacheClient> {
  const client = await createClient(options);
  open.push(client);
  return client;
}

/**
 * SharedWorkers as a browser finds them, by URL and name: one server per
 * pair, each on the bus, started in the order they were created.
 */
function installWorkers(bus: Bus, store = new MemoryStore()) {
  const servers = new Map<string, RpcServer>();
  const created: { url: string; options: unknown }[] = [];
  vi.stubGlobal("Worker", undefined);
  vi.stubGlobal(
    "SharedWorker",
    class {
      port: unknown;
      constructor(url: string | URL, options?: { name?: string }) {
        created.push({ url: String(url), options });
        const key = `${String(url)}|${options?.name ?? ""}`;
        let server = servers.get(key);
        if (server === undefined) {
          ({ server } = shared(
            bus,
            {
              url: String(url),
              startedAt: servers.size + 1,
              ...(options?.name === undefined ? {} : { name: options.name }),
            },
            store,
          ));
          servers.set(key, server);
        }
        const channel = new MessageChannel();
        server.attach(channel.port1 as MessagePortLike);
        this.port = channel.port2;
      }
      addEventListener() {}
      removeEventListener() {}
    },
  );
  return { servers, created, store };
}

/** One server behind every SharedWorker, whatever its name. */
function installOneWorker(server: RpcServer): void {
  vi.stubGlobal(
    "SharedWorker",
    class {
      port: unknown;
      constructor() {
        const channel = new MessageChannel();
        server.attach(channel.port1 as MessagePortLike);
        this.port = channel.port2;
      }
      addEventListener() {}
      removeEventListener() {}
    },
  );
}

const supersededEvt = (lib: string): Evt => ({
  t: "evt",
  scope: "client",
  event: "superseded",
  payload: { lib },
});
const stoppedEvt = (cacheId: string): Evt => ({
  t: "evt",
  scope: "cache",
  cacheId,
  event: "persistStopped",
  payload: { cacheId, reason: "superseded" },
});

describe("13: the SharedWorker's name (N125, N126)", () => {
  it("is the generation key, with the fetcher module as the page passes it", async () => {
    const { created, servers } = installWorkers(fakeChannels());
    await make({ workerUrl, fetcher: { module: moduleA } });
    await make({ workerUrl, fetcher: { module: new URL(moduleA) } });
    await make({ workerUrl });
    expect(created.map(({ options }) => options)).toEqual([
      {
        type: "module",
        extendedLifetime: true,
        name: `tscache:${LIB_VERSION}:${moduleA}`,
      },
      {
        type: "module",
        extendedLifetime: true,
        name: `tscache:${LIB_VERSION}:${moduleA}`,
      },
      {
        type: "module",
        extendedLifetime: true,
        name: `tscache:${LIB_VERSION}:`,
      },
    ]);
    // Two keys, so two workers; the two pages with one key share theirs.
    expect(servers.size).toBe(2);
  });

  it("the dedicated worker is created without a name", async () => {
    const options: unknown[] = [];
    vi.stubGlobal("SharedWorker", undefined);
    vi.stubGlobal("Worker", function FakeWorker(_url: unknown, given: unknown) {
      options.push(given);
      const channel = new MessageChannel();
      new RpcServer(new Engine(), LIB_VERSION).attach(
        channel.port1 as MessagePortLike,
      );
      const port = channel.port2;
      return {
        postMessage: (m: unknown, t?: Transferable[]) =>
          port.postMessage(m, t ?? []),
        addEventListener: (type: string, fn: EventListener) => {
          if (type !== "error") port.addEventListener(type, fn);
        },
        removeEventListener: (type: string, fn: EventListener) => {
          if (type !== "error") port.removeEventListener(type, fn);
        },
        start: () => port.start(),
        close: () => port.close(),
        terminate: () => port.close(),
      };
    });
    const client = await make({ workerUrl, fetcher: { module: moduleA } });
    expect(client.mode).toBe("dedicated");
    expect(options).toEqual([{ type: "module" }]);
  });
});

describe("15: the superseded event (N129, N132)", () => {
  it("goes to every ready connection before the stop's persistStopped, and to a later one after its init-ok", async () => {
    const bus = fakeChannels();
    const a = shared(bus, { startedAt: 1 });
    const a1 = await connect(a.server, moduleA);
    const a2 = await connect(a.server, moduleA);
    await a1.client.request("cache", config());
    await a1.client.request("cache", plain);
    await a2.client.request("subscribe", { all: true });
    await a1.client.request("put", { cacheId: "persist", batch: batch([0]) });
    await barrier(a2.client);
    a1.events.length = 0;
    a2.events.length = 0;

    // Another fetcher module, started later, of another library version.
    const b = shared(bus, { startedAt: 2, lib: "9.9.9" });
    const b1 = await connect(b.server, moduleB);
    await barrier(a1.client);
    await barrier(a2.client);
    await barrier(b1.client);

    // The payload's lib is the higher-ranked worker's, from its message. The
    // subscribed connection hears no cacheChanged and nobody a cacheCleared.
    const expected = [supersededEvt("9.9.9"), stoppedEvt("persist")];
    expect(a1.events).toEqual(expected);
    expect(a2.events).toEqual(expected);
    expect(b1.events).toEqual([]);
    // The engine is untouched: the point is still read from memory.
    const got = (await a1.client.request("get", {
      cacheId: "persist",
      range: { start: 0, end: 0 },
      options: { cacheOnly: true },
    })) as { timestamps: Float64Array };
    expect([...got.timestamps]).toEqual([0]);

    const a3 = await connect(a.server, moduleA);
    await barrier(a3.client);
    expect(a3.events).toEqual([supersededEvt("9.9.9")]);
    // A third, still higher worker changes nothing for the superseded one.
    const c = shared(bus, { startedAt: 3, lib: "10.0.0" });
    await connect(c.server, moduleA);
    await barrier(a1.client);
    expect(a1.events).toEqual(expected);
  });

  it("sets client.superseded before its listeners run, once, and prints one note in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { servers } = installWorkers(fakeChannels());
    const tabA = await make({ workerUrl, fetcher: { module: moduleA } });
    const heard: unknown[] = [];
    tabA.on("superseded", (payload) => heard.push([payload, tabA.superseded]));
    const stops: unknown[] = [];
    tabA.on("persistStopped", (payload) =>
      stops.push([payload.reason, tabA.superseded]),
    );
    await tabA.cache(config());
    expect(tabA.superseded).toBeUndefined();

    const tabB = await make({ workerUrl, fetcher: { module: moduleB } });
    await tabA.cache(plain);
    await tabB.cache(plain);
    expect(servers.size).toBe(2);
    const payload = { lib: LIB_VERSION };
    expect(heard).toEqual([[payload, payload]]);
    // A persistStopped listener that sees 'superseded' finds the property set.
    expect(stops).toEqual([["superseded", payload]]);
    expect(tabA.superseded).toEqual(payload);
    expect(tabB.superseded).toBeUndefined();
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toContain(`tscache ${LIB_VERSION}`);

    // A third generation: the first tab is told nothing more.
    const tabC = await make({
      workerUrl,
      fetcher: { module: fetcherModule("c") },
    });
    await tabA.cache(plain);
    await tabB.cache(plain);
    expect(heard).toHaveLength(1);
    expect(tabB.superseded).toEqual(payload);
    expect(tabC.superseded).toBeUndefined();
    expect(info).toHaveBeenCalledTimes(2);
  });

  it("prints no note in a production build", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    installWorkers(fakeChannels());
    const tabA = await make({ workerUrl, fetcher: { module: moduleA } });
    await make({ workerUrl, fetcher: { module: moduleB } });
    await tabA.cache(plain);
    expect(tabA.superseded).toEqual({ lib: LIB_VERSION });
    expect(info).not.toHaveBeenCalled();
  });

  it("a client ignores a client-scoped event name it does not know", () => {
    const emitter = new ClientEmitter();
    const heard = vi.fn();
    emitter.on("superseded", heard);
    emitter.on("authInvalid", heard);
    emitter.receive({
      t: "evt",
      scope: "client",
      event: "from-a-later-release",
      payload: {},
    });
    expect(heard).not.toHaveBeenCalled();
  });

  it("an unnamed worker whose later init loads its first fetcher answers with it and is superseded by a peer of another module started after (gate round 5, R5-2)", async () => {
    const bus = fakeChannels();
    // A page of 0.1.0 or 0.2.0 at a fixed URL passes no name (§4.7).
    const old = shared(bus, { startedAt: 1 });
    const bare = await connect(old.server);
    const loaded = await connect(old.server, moduleA);
    const before = bus.posts.length;
    const peer = shared(bus, {
      startedAt: 2,
      name: `tscache:${LIB_VERSION}:${moduleB}`,
    });
    const named = await connect(peer.server, moduleB);
    await barrier(bare.client);
    await barrier(loaded.client);
    await barrier(named.client);
    // Nothing more was announced; the answer carries the module it loaded.
    const later = bus.posts.slice(before);
    expect(later.map((m) => m.t)).toEqual(["announce", "present"]);
    expect(later[1]).toMatchObject({
      t: "present",
      fetcher: new URL(moduleA, workerUrl).href,
    });
    expect(later[1]).not.toHaveProperty("name");
    expect(bare.events).toEqual([supersededEvt(LIB_VERSION)]);
    expect(loaded.events).toEqual([supersededEvt(LIB_VERSION)]);
    expect(named.events).toEqual([]);
  });

  it("reports the first fetcher a later init loads once, and never when the first init named one", async () => {
    const firsts: (string | undefined)[] = [];
    const later: string[] = [];
    const options = {
      onFirstInit: (fetcher: string | undefined) => firsts.push(fetcher),
      onFirstFetcher: (fetcher: string) => later.push(fetcher),
    };
    const bare = new RpcServer(
      new Engine(),
      LIB_VERSION,
      undefined,
      undefined,
      options,
    );
    await connect(bare);
    await connect(bare);
    await connect(bare, moduleA);
    await connect(bare, moduleA);
    expect(firsts).toEqual([undefined]);
    expect(later).toEqual([moduleA]);
    const withModule = new RpcServer(
      new Engine(),
      LIB_VERSION,
      undefined,
      undefined,
      options,
    );
    await connect(withModule, moduleA);
    await connect(withModule);
    await connect(withModule, moduleA);
    expect(firsts).toEqual([undefined, moduleA]);
    expect(later).toEqual([moduleA]);
  });

  it("two tabs with one key share a worker, and a tab without a fetcher beside them supersedes nobody", async () => {
    const { servers } = installWorkers(fakeChannels());
    const first = await make({ workerUrl, fetcher: { module: moduleA } });
    const second = await make({ workerUrl, fetcher: { module: moduleA } });
    const bare = await make({ workerUrl });
    for (const tab of [first, second, bare]) await tab.cache(plain);
    expect(servers.size).toBe(2);
    expect([first.superseded, second.superseded, bare.superseded]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe("16: clearAll across workers (N135)", () => {
  it("a worker hearing another's clearAll clears memory and disk for each message, and relays once", async () => {
    const bus = fakeChannels();
    const store = new MemoryStore();
    store.seed("persist", fixture());
    const a = shared(bus, { startedAt: 1 }, store);
    const b = shared(bus, { startedAt: 1 }, store);
    const a1 = await connect(a.server);
    const b1 = await connect(b.server);
    await a1.client.request("cache", config());
    await b1.client.request("cache", config());
    await b1.client.request("put", { cacheId: "persist", batch: batch([0]) });
    a1.events.length = 0;
    b1.events.length = 0;
    bus.posts.length = 0;

    await a1.client.request("clearAll", {});
    await vi.waitFor(() => expect(bus.posts).toHaveLength(3), {
      timeout: 4000,
      interval: 1,
    });
    await barrier(b1.client);
    await barrier(a1.client);

    // A's two posts and B's one relay, all under A's clear id.
    const clearId = bus.posts[0]?.clear;
    expect(typeof clearId).toBe("string");
    expect(bus.posts.map(({ t, clear }) => [t, clear])).toEqual([
      ["clearAll", clearId],
      ["clearAll", clearId],
      ["clearAll", clearId],
    ]);
    const senders = bus.posts.map(({ id }) => id);
    expect(new Set(senders).size).toBe(2);
    expect(senders.filter((id) => id === senders[0])).toHaveLength(2);
    // B cleared once for each of A's posts; A for its call and B's relay.
    const clears = (events: Evt[]) =>
      events.filter(({ event }) => event === "cacheCleared").length;
    expect(clears(b1.events)).toBe(2);
    expect(clears(a1.events)).toBe(2);
    expect(b1.events[0]).toEqual({
      t: "evt",
      scope: "cache",
      cacheId: "persist",
      event: "cacheCleared",
      payload: { cacheId: "persist", reason: "clear-all" },
    });
    const got = (await b1.client.request("get", {
      cacheId: "persist",
      range: { start: 0, end: 0 },
      options: { cacheOnly: true },
    })) as { timestamps: Float64Array };
    expect(got.timestamps).toHaveLength(0);
    // Each worker ran a disk clear of its own (a clear that arrives while
    // one is pending joins it, §4.10.6), and nothing was written back.
    expect(store.log.filter(({ kind }) => kind === "write")).toEqual([]);
    expect(
      store.log.filter(({ kind }) => kind === "clearAll").length,
    ).toBeGreaterThanOrEqual(2);
    expect(store.records("persist")).toEqual({ cache: undefined, pages: [] });
  });

  it("is subscribed before its first init-ok: a clear heard with no connection is run and relayed", async () => {
    const bus = fakeChannels();
    const { server, store } = shared(bus);
    expect(server.connections).toBe(0);
    bus.open().postMessage({ t: "clearAll", v: 1, id: "other", clear: "c1" });
    await vi.waitFor(() => expect(bus.posts).toHaveLength(2), {
      timeout: 4000,
      interval: 1,
    });
    expect(store?.log.map(({ kind }) => kind)).toEqual(["clearAll"]);
    expect(bus.posts[1]).toMatchObject({ t: "clearAll", v: 1, clear: "c1" });
    expect(bus.posts[1]?.id).not.toBe("other");
  });

  it("a SharedWorker without IndexedDB clears its memory and posts nothing", async () => {
    const bus = fakeChannels();
    const { server } = shared(bus, {}, null);
    const a1 = await connect(server);
    await a1.client.request("cache", plain);
    await a1.client.request("put", { cacheId: "plain", batch: batch([0]) });
    a1.events.length = 0;
    bus.posts.length = 0;
    bus.open().postMessage({ t: "clearAll", v: 1, id: "other", clear: "c1" });
    await barrier(a1.client);
    expect(a1.events.map(({ event }) => event)).toEqual(["cacheCleared"]);
    // Its own clearAll posts nothing either: it has no persistence.
    await a1.client.request("clearAll", {});
    expect(bus.posts).toHaveLength(1);
  });

  it("the dedicated worker's hosting opens the channel at the call and closes it after its second post", async () => {
    const bus = fakeChannels();
    bus.install();
    const store = new MemoryStore();
    const listener = shared(bus, {}, null);
    const heard = await connect(listener.server);
    await heard.client.request("cache", plain);
    heard.events.length = 0;
    const dedicated = createServer(
      undefined,
      async () => store,
      undefined,
      true,
    );
    const tab = await connect(dedicated);
    expect(bus.counts).toEqual({ opened: 1, open: 1 });
    bus.posts.length = 0;

    const gate = store.gate("clearAll");
    const clearing = tracked(tab.client.request("clearAll", {}).then(() => {}));
    await gate.entered;
    // The first post is out, the channel is held open for the second.
    expect(bus.posts).toHaveLength(1);
    expect(bus.counts).toEqual({ opened: 2, open: 2 });
    expect(clearing.done).toBe(false);
    gate.release();
    await clearing.promise;
    expect(bus.posts).toHaveLength(2);
    expect(bus.posts[1]).toEqual(bus.posts[0]);
    expect(bus.counts).toEqual({ opened: 2, open: 1 });
    // The SharedWorker beside it cleared for both posts.
    await barrier(heard.client);
    expect(heard.events.map(({ event }) => event)).toEqual([
      "cacheCleared",
      "cacheCleared",
    ]);
  });

  it("the in-process hosting posts its clearAll, and nothing in a realm without IndexedDB", async () => {
    const bus = fakeChannels();
    bus.install();
    const client = await make({ mode: "in-process" });
    await client.clearAll();
    expect(bus.posts).toEqual([]);
    expect(bus.counts).toEqual({ opened: 0, open: 0 });

    vi.stubGlobal("indexedDB", new IDBFactory());
    const persisting = await make({ mode: "in-process" });
    await persisting.clearAll();
    expect(bus.posts).toHaveLength(2);
    expect(bus.posts[0]).toMatchObject({ t: "clearAll", v: 1 });
    expect(bus.posts[1]).toEqual(bus.posts[0]);
    expect(bus.counts).toEqual({ opened: 1, open: 0 });
  });
});

describe("17: hello.lib (N136)", () => {
  /** A port whose server's hello carries `lib` as given, even malformed. */
  function helloWith(lib: unknown): MessagePortLike {
    const channel = new MessageChannel();
    const port = channel.port1;
    const wrapped: MessagePortLike = {
      postMessage: (m: unknown, t?: Transferable[]) => {
        const message = m as { t?: string };
        if (message.t !== "hello") port.postMessage(m, t ?? []);
        else if (lib === undefined) {
          const { lib: _dropped, ...rest } = m as Record<string, unknown>;
          port.postMessage(rest);
        } else port.postMessage({ ...message, lib });
      },
      addEventListener: (type, fn) =>
        port.addEventListener(type, fn as EventListener),
      removeEventListener: (type, fn) =>
        port.removeEventListener(type, fn as EventListener),
      start: () => port.start(),
      close: () => port.close(),
    };
    new RpcServer(new Engine(), LIB_VERSION).attach(wrapped);
    open.push({ dispose: () => channel.port1.close() });
    return channel.port2 as MessagePortLike;
  }

  it.each([
    { lib: "0.1.0", kept: "0.1.0" },
    { lib: "99.0.0", kept: "99.0.0" },
    { lib: undefined, kept: undefined },
    { lib: 7, kept: undefined },
    { lib: { toString: null }, kept: undefined },
  ])(
    "the port client keeps $lib as $kept, and the handshake does not act on it",
    async ({ lib, kept }) => {
      const client = await PortClient.connect(helloWith(lib));
      open.push(client);
      expect(client.lib).toBe(kept);
      // Today's features, whatever the lib; and the connection works.
      expect([...client.features].sort()).toEqual([
        "cacheChanged",
        "calendar-grid",
        "memoryBudget",
      ]);
      await expect(client.request("cache", plain)).resolves.toMatchObject({
        id: "plain",
      });
    },
  );

  it.each([
    { lib: "0.1.0", text: "is tscache 0.1.0" },
    { lib: "99.0.0", text: "is tscache 99.0.0" },
    { lib: undefined, text: "reports no version" },
  ])(
    "a client warns once in development when its worker $text, and connects",
    async ({ lib, text }) => {
      vi.stubEnv("NODE_ENV", "development");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.stubGlobal(
        "SharedWorker",
        class {
          port = helloWith(lib);
          addEventListener() {}
          removeEventListener() {}
        },
      );
      const client = await make({ workerUrl });
      expect(client.mode).toBe("shared");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain(
        `this page runs tscache ${LIB_VERSION}`,
      );
      expect(warn.mock.calls[0]?.[0]).toContain(text);
      await client.cache(plain);
      expect(warn).toHaveBeenCalledTimes(1);
    },
  );

  it("prints nothing in a production build, nor when the versions are equal", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "SharedWorker",
      class {
        port = helloWith("0.1.0");
        addEventListener() {}
        removeEventListener() {}
      },
    );
    vi.stubEnv("NODE_ENV", "production");
    await make({ workerUrl });
    expect(warn).not.toHaveBeenCalled();

    vi.stubEnv("NODE_ENV", "development");
    installOneWorker(new RpcServer(new Engine(), LIB_VERSION));
    await make({ workerUrl });
    expect(warn).not.toHaveBeenCalled();
  });

  it("compares in the dedicated hosting alike, and never warns in-process", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("SharedWorker", undefined);
    vi.stubGlobal("Worker", function FakeWorker() {
      const port = helloWith("0.1.0") as MessagePortLike & {
        terminate?: () => void;
      };
      const worker = {
        postMessage: (m: unknown, t?: Transferable[]) => port.postMessage(m, t),
        addEventListener: (type: string, fn: never) => {
          if (type !== "error") port.addEventListener(type as "message", fn);
        },
        removeEventListener: (type: string, fn: never) => {
          if (type !== "error") port.removeEventListener(type as "message", fn);
        },
        start: () => port.start?.(),
        close: () => port.close?.(),
        terminate: () => port.close?.(),
      };
      return worker;
    });
    const dedicated = await make({ workerUrl });
    expect(dedicated.mode).toBe("dedicated");
    expect(warn).toHaveBeenCalledTimes(1);

    const inProcess = await make({ mode: "in-process" });
    expect(inProcess.mode).toBe("in-process");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("31: budget and stats on a superseded worker (N88, N101, N103)", () => {
  const stats = (client: PortClient) =>
    client.request("memoryStats", {}) as Promise<MemoryStats>;

  it("an engine without a budget and without a cache still takes one; any other answers the budget in force", async () => {
    const a = shared(fakeChannels());
    const a1 = await connect(a.server);
    a.server.supersede({ lib: "9.9.9" });
    const budget = 4 * PAGE_BYTES;
    expect(await a1.client.request("memoryBudget", { bytes: budget })).toEqual({
      budget,
    });
    expect(await a1.client.request("memoryBudget", { bytes: 1 })).toEqual({
      budget,
    });

    const b = shared(fakeChannels());
    const b1 = await connect(b.server);
    await b1.client.request("cache", plain);
    b.server.supersede({ lib: "9.9.9" });
    expect(await b1.client.request("memoryBudget", { bytes: budget })).toEqual(
      {},
    );
  });

  it("memoryStats answers after the stop what it answered before, and the client's budget warning is unchanged", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { server } = shared(fakeChannels());
    installOneWorker(server);
    const budget = 4 * PAGE_BYTES;
    const first = await make({ workerUrl, memoryBudget: budget });
    const cache = await first.cache(config());
    await cache.put(batch([0, 4]));
    const before = await first.memoryStats();
    expect(before).toMatchObject({ budget, bytes: 2 * PAGE_BYTES });

    server.supersede({ lib: "9.9.9" });
    expect(await first.memoryStats()).toEqual(before);
    expect(warn).not.toHaveBeenCalled();
    const second = await make({ workerUrl, memoryBudget: PAGE_BYTES });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(
      `memoryBudget ${PAGE_BYTES} is not in force`,
    );
    expect(await second.memoryStats()).toEqual(before);
  });

  it("neither op waits for a loading persistence chunk, a clearAll in progress or a clear from the channel", async () => {
    const engine = new Engine({ memoryBudget: 4 * PAGE_BYTES });
    const store = new MemoryStore();
    const chunk = deferred<typeof lazy>();
    const persistence = new HostedPersistence(
      engine,
      () => chunk.promise,
      async () => store,
    );
    const server = new RpcServer(engine, LIB_VERSION, undefined, persistence);
    const { client } = await connect(server);
    const answered = async () => {
      const report = await stats(client);
      const budget = await client.request("memoryBudget", { bytes: 1 });
      return [report.budget, budget];
    };
    const inForce = [4 * PAGE_BYTES, { budget: 4 * PAGE_BYTES }];

    // The persisted cache's open waits for the chunk.
    const opening = tracked(
      client.request("cache", config()).then(() => undefined),
    );
    expect(await answered()).toEqual(inForce);
    expect(opening.done).toBe(false);
    server.supersede({ lib: "9.9.9" });
    expect(await answered()).toEqual(inForce);
    chunk.resolve(lazy);
    await opening.promise;
    await client.request("put", { cacheId: "persist", batch: batch([0]) });
    expect((await stats(client)).bytes).toBe(PAGE_BYTES);

    // A clearAll of one of its own tabs, held in the store.
    const own = store.gate("clearAll");
    const clearing = tracked(client.request("clearAll", {}).then(() => {}));
    await own.entered;
    expect(await answered()).toEqual(inForce);
    expect(clearing.done).toBe(false);
    own.release();
    await clearing.promise;

    // A clear from the channel, held in the store.
    await client.request("put", { cacheId: "persist", batch: batch([4]) });
    const remote = store.gate("clearAll");
    server.channelClear("remote-clear");
    await remote.entered;
    expect(await answered()).toEqual(inForce);
    // No bytes, the same budget, and the budget op answers it still.
    expect(await stats(client)).toMatchObject({
      budget: 4 * PAGE_BYTES,
      bytes: 0,
    });
    remote.release();
  });
});

describe("32: a channel clear's events (N78, N135)", () => {
  it("each cache, an empty one included, sends cacheCleared to every connection and cacheChanged without a requestId to the subscribed ones", async () => {
    const { server } = shared(fakeChannels());
    const quiet = await connect(server);
    const reader = await connect(server);
    await quiet.client.request("cache", config());
    await quiet.client.request("cache", plain);
    await quiet.client.request("put", {
      cacheId: "persist",
      batch: batch([0]),
    });
    await reader.client.request("subscribe", { all: true });
    await barrier(reader.client);
    quiet.events.length = 0;
    reader.events.length = 0;

    const cleared = (cacheId: string): Evt => ({
      t: "evt",
      scope: "cache",
      cacheId,
      event: "cacheCleared",
      payload: { cacheId, reason: "clear-all" },
    });
    const changed = (cacheId: string): Evt => ({
      t: "evt",
      scope: "cache",
      cacheId,
      event: "cacheChanged",
      payload: { cacheId, written: [], removed: [], cleared: true },
    });
    const once = [
      cleared("persist"),
      changed("persist"),
      cleared("plain"),
      changed("plain"),
    ];

    server.channelClear("remote-1");
    await barrier(quiet.client);
    await barrier(reader.client);
    expect(quiet.events).toStrictEqual([cleared("persist"), cleared("plain")]);
    // toStrictEqual: the payload has no requestId key at all.
    expect(reader.events).toStrictEqual(once);

    // Once for each message it acts on, a known clear id included.
    server.channelClear("remote-1");
    await barrier(reader.client);
    expect(reader.events).toStrictEqual([...once, ...once]);

    // A clearAll op from one of its own tabs still names its request.
    reader.events.length = 0;
    await quiet.client.request("clearAll", {});
    await barrier(reader.client);
    const own = reader.events.filter(({ event }) => event === "cacheChanged");
    expect(own).toHaveLength(2);
    for (const evt of own) {
      expect((evt.payload as { requestId?: string }).requestId).toMatch(
        new RegExp(`^${quiet.client.clientId}:\\d+$`),
      );
    }
  });
});

describe("36: the refusal's code across the port (N141)", () => {
  const message = `this worker already runs fetcher ${moduleA}; cannot also load ${moduleB}`;

  it("a second fetcher module is answered init-err with the name, the message and the code", async () => {
    const server = new RpcServer(new Engine(), LIB_VERSION);
    await connect(server, moduleA);
    const channel = new MessageChannel();
    const replies: unknown[] = [];
    const answered = deferred<void>();
    channel.port2.addEventListener("message", (event) => {
      const data = (event as MessageEvent).data as { t?: string };
      if (data.t === "hello") {
        channel.port2.postMessage({
          t: "init",
          protocol: PROTOCOL_VERSION,
          fetcher: { module: moduleB },
        });
      } else {
        replies.push(data);
        answered.resolve();
      }
    });
    channel.port2.start();
    server.attach(channel.port1 as MessagePortLike);
    open.push({ dispose: () => channel.port2.close() });
    await answered.promise;
    expect(replies).toEqual([
      {
        t: "init-err",
        error: { name: "ConfigError", message, code: "fetcher-conflict" },
      },
    ]);
    // A client from before the code rebuilds it from the name and the
    // message alone: the same class, and its prefix check still holds.
    const wire = (replies[0] as { error: WireError }).error;
    const old = new ConfigError(wire.message);
    expect(old.name).toBe(wire.name);
    expect(old.message.startsWith("this worker already runs fetcher")).toBe(
      true,
    );
  });

  it("createClient rejects with the coded ConfigError and does not fall back", async () => {
    installOneWorker(new RpcServer(new Engine(), LIB_VERSION));
    const fallback = vi.fn();
    vi.stubGlobal("Worker", fallback);
    await make({ workerUrl, fetcher: { module: moduleA } });
    const refused = createClient({ workerUrl, fetcher: { module: moduleB } });
    await expect(refused).rejects.toBeInstanceOf(ConfigError);
    await expect(refused).rejects.toMatchObject({
      name: "ConfigError",
      message,
      code: "fetcher-conflict",
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  it.each([
    { wire: { name: "ConfigError", message: "m" }, code: undefined },
    {
      wire: { name: "ConfigError", message: "m", code: "later" },
      code: undefined,
    },
    { wire: { name: "ConfigError", message: "m", code: 7 }, code: undefined },
    {
      wire: { name: "ConfigError", message: "m", code: "fetcher-conflict" },
      code: "fetcher-conflict",
    },
  ])("rebuilds $wire with code $code", ({ wire, code }) => {
    const error = fromWireError(wire as WireError);
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toBe("m");
    expect((error as ConfigError).code).toBe(code);
    expect(Object.hasOwn(error, "code")).toBe(code !== undefined);
  });
});
