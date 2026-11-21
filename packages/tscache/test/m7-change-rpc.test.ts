import { afterEach, describe, expect, it, vi } from "vitest";
import { ChangeSubscriptions } from "../src/client/changes";
import { createClient, type TscacheClient } from "../src/client/client";
import { Engine, observeCaches } from "../src/engine/engine";
import { TscacheError } from "../src/errors";
import { PortClient } from "../src/rpc/port-client";
import {
  type Evt,
  type MessagePortLike,
  PROTOCOL_VERSION,
  type Req,
  type ToClient,
} from "../src/rpc/protocol";
import { type Persistence, RpcServer } from "../src/rpc/server";
import type {
  CacheConfig,
  ClientEvents,
  GetResult,
  PutBatch,
} from "../src/types";

// Implementer tests for M7 over the port (spec tests 12-21 of
// docs/design/m7-change-events.md §5; architecture §2.7, §4.7-§4.8). Every
// absence is proved by a later answer on the same port, never a pause
// (docs/testing.md, Waiting).

type Changed = ClientEvents["cacheChanged"];

const id = "m7";
const config: CacheConfig = {
  id,
  interval: 10,
  alignmentOffset: 3,
  fields: { value: "f64" },
};

function batch(
  timestamps: number[],
  values: number[] = timestamps,
  meta?: PutBatch["meta"],
): PutBatch {
  return {
    timestamps: new Float64Array(timestamps),
    fields: { value: new Float64Array(values) },
    ...(meta === undefined ? {} : { meta }),
  };
}

/** Fetcher control shared with the module below; read per call. */
interface Control {
  mode: "ok" | "fail" | "auth";
  calls: number;
  /** When set, the next fetch waits for it (and clears it). */
  hold?: Promise<void>;
  started?: () => void;
}
const control = (): Control =>
  (globalThis as unknown as { __m7rpc: Control }).__m7rpc;
function resetControl(): void {
  (globalThis as unknown as { __m7rpc: Control }).__m7rpc = {
    mode: "ok",
    calls: 0,
  };
}

/** Answers every fetch with one point at 13, unless told to fail. */
const fetcherModule = `data:text/javascript,${encodeURIComponent(`
  export default {
    async fetch() {
      const g = globalThis.__m7rpc;
      g.calls++;
      if (g.hold !== undefined) {
        const hold = g.hold;
        g.hold = undefined;
        g.started?.();
        await hold;
      }
      if (g.mode === "fail") throw new Error("backend down");
      if (g.mode === "auth") {
        const e = new Error("401");
        e.code = "tscache:auth-invalid";
        throw e;
      }
      return { timestamps: [13], fields: { value: [9] } };
    },
  };
`)}`;

/** Holds the next fetch until the returned release is called. */
function holdNextFetch(): { entered: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  let started: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  control().hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  control().started = started;
  return { entered, release };
}

const open: { dispose(): unknown }[] = [];
afterEach(async () => {
  for (const item of open.splice(0)) await item.dispose();
  vi.restoreAllMocks();
  resetControl();
});
resetControl();

interface Wire {
  client: PortClient;
  /** Every message this side received, in arrival order. */
  log: ToClient[];
  /** Every request this side posted, in order. */
  sent: Req[];
  port: MessagePortLike;
}

async function wire(
  server: RpcServer,
  options: { fetcher?: boolean } = {},
): Promise<Wire> {
  const channel = new MessageChannel();
  const log: ToClient[] = [];
  channel.port2.addEventListener("message", (e) => {
    log.push(e.data as ToClient);
  });
  const sent: Req[] = [];
  const port = channel.port2 as unknown as {
    postMessage(message: unknown, transfer?: Transferable[]): void;
  };
  const post = port.postMessage.bind(port);
  port.postMessage = (message, transfer) => {
    if ((message as { t?: string }).t === "req") sent.push(message as Req);
    post(message, transfer ?? []);
  };
  server.attach(channel.port1 as MessagePortLike);
  const client = await PortClient.connect(
    channel.port2 as MessagePortLike,
    options.fetcher === true ? { fetcher: { module: fetcherModule } } : {},
  );
  open.push(client);
  return { client, log, sent, port: channel.port1 as MessagePortLike };
}

/** A round trip on the port: everything the server sent before has arrived. */
const barrier = (w: Wire) => w.client.request("cache", config);

/** The kind of each message: `evt:<name>` or `res`. */
function labels(messages: ToClient[]): string[] {
  return messages.flatMap((m) =>
    m.t === "evt" ? [`evt:${m.event}`] : m.t === "res" ? ["res"] : [],
  );
}

function changes(messages: ToClient[]): Changed[] {
  return messages.flatMap((m) =>
    m.t === "evt" && m.event === "cacheChanged" ? [m.payload as Changed] : [],
  );
}

/** Posts a request; returns its public RequestId (§2.7) and its answer. */
function send(
  w: Wire,
  op: Req["op"],
  params: unknown,
): { requestId: string; answer: Promise<unknown> } {
  const before = w.sent.length;
  const answer = w.client.request(op, params);
  const req = w.sent[before] as Req;
  return { requestId: `${w.client.clientId}:${req.id}`, answer };
}

/** As send, awaiting the answer. */
async function call(
  w: Wire,
  op: Req["op"],
  params: unknown,
): Promise<{ requestId: string; result: unknown }> {
  const { requestId, answer } = send(w, op, params);
  return { requestId, result: await answer };
}

describe("M7 over the port: order and fan-out (tests 12-13)", () => {
  it("one put sends cacheCleared, cacheChanged, mergeWarning, then its response", async () => {
    const server = new RpcServer(new Engine(), "0.0.0");
    const a = await wire(server);
    await a.client.request("cache", {
      ...config,
      version: "v1",
      warnOnOverlapDiff: true,
    });
    await a.client.request("subscribe", { cacheId: id });
    await a.client.request("put", { cacheId: id, batch: batch([13], [1]) });

    let mark = a.log.length;
    const differing = await call(a, "put", {
      cacheId: id,
      batch: batch([13], [2]),
    });
    expect(labels(a.log.slice(mark))).toEqual([
      "evt:cacheChanged",
      "evt:mergeWarning",
      "res",
    ]);
    expect(changes(a.log.slice(mark))).toEqual([
      {
        cacheId: id,
        written: [{ start: 13, end: 13 }],
        removed: [],
        cleared: false,
        requestId: differing.requestId,
      },
    ]);

    mark = a.log.length;
    const restated = await call(a, "put", {
      cacheId: id,
      batch: batch([23], [3], { version: "v2" }),
    });
    expect(labels(a.log.slice(mark))).toEqual([
      "evt:cacheCleared",
      "evt:cacheChanged",
      "res",
    ]);
    expect(changes(a.log.slice(mark))).toEqual([
      {
        cacheId: id,
        written: [{ start: 23, end: 23 }],
        removed: [],
        cleared: true,
        requestId: restated.requestId,
      },
    ]);

    mark = a.log.length;
    const cleared = await call(a, "clear", { cacheId: id });
    expect(labels(a.log.slice(mark))).toEqual([
      "evt:cacheCleared",
      "evt:cacheChanged",
      "res",
    ]);
    expect(changes(a.log.slice(mark))).toEqual([
      {
        cacheId: id,
        written: [],
        removed: [],
        cleared: true,
        requestId: cleared.requestId,
      },
    ]);
  });

  it("sends only to subscribed connections, every cache's to subscribe { all }, and nothing after unsubscribe", async () => {
    const server = new RpcServer(new Engine(), "0.0.0");
    const one = await wire(server);
    const none = await wire(server);
    const all = await wire(server);
    await none.client.request("cache", config);
    await none.client.request("cache", { ...config, id: "other" });
    await one.client.request("subscribe", { cacheId: id });
    await all.client.request("subscribe", { all: true });

    const put = await call(none, "put", { cacheId: id, batch: batch([13]) });
    await barrier(one);
    await barrier(all);
    const expected: Changed = {
      cacheId: id,
      written: [{ start: 13, end: 13 }],
      removed: [],
      cleared: false,
      requestId: put.requestId,
    };
    expect(changes(one.log)).toEqual([expected]);
    expect(changes(all.log)).toEqual([expected]);
    expect(changes(none.log)).toEqual([]);

    await none.client.request("put", { cacheId: "other", batch: batch([3]) });
    await barrier(one);
    await barrier(all);
    expect(changes(one.log)).toHaveLength(1);
    expect(changes(all.log).map((c) => c.cacheId)).toEqual([id, "other"]);

    await one.client.request("unsubscribe", { cacheId: id });
    await all.client.request("unsubscribe", { all: true });
    await none.client.request("put", { cacheId: id, batch: batch([23]) });
    await barrier(one);
    await barrier(all);
    expect(changes(one.log)).toHaveLength(1);
    expect(changes(all.log)).toHaveLength(2);
    expect(changes(none.log)).toEqual([]);
  });

  it("a connection holding both subscriptions hears each change once; bad params reject", async () => {
    const server = new RpcServer(new Engine(), "0.0.0");
    const a = await wire(server);
    await a.client.request("cache", config);
    await a.client.request("subscribe", { cacheId: id });
    await a.client.request("subscribe", { cacheId: id });
    await a.client.request("subscribe", { all: true });
    await a.client.request("put", { cacheId: id, batch: batch([13]) });
    expect(changes(a.log)).toHaveLength(1);
    for (const params of [
      {},
      { cacheId: 7 },
      { all: false },
      { all: true, cacheId: id },
    ]) {
      await expect(
        a.client.request("subscribe", params),
      ).rejects.toBeInstanceOf(TscacheError);
      await expect(
        a.client.request("unsubscribe", params),
      ).rejects.toBeInstanceOf(TscacheError);
    }
  });
});

describe("M7 client listeners (test 14)", () => {
  async function inProcess(): Promise<TscacheClient> {
    const client = await createClient({ mode: "in-process" });
    open.push(client);
    return client;
  }

  it("the first listener subscribes, the last one's removal unsubscribes, client.on and cache.on combine", async () => {
    const request = vi.spyOn(PortClient.prototype, "request");
    const sent = () =>
      request.mock.calls
        .filter(([op]) => op === "subscribe" || op === "unsubscribe")
        .map(([op, params]) => [op, params]);
    const client = await inProcess();
    expect(client.features).toEqual(
      new Set(["cacheChanged", "memoryBudget", "calendar-grid"]),
    );
    const cache = await client.cache(config);
    const heard: string[] = [];
    const first = (c: Changed) => heard.push(`first ${c.cacheId}`);
    const second = (c: Changed) => heard.push(`second ${c.cacheId}`);
    const every = (c: Changed) => heard.push(`every ${c.cacheId}`);

    cache.on("cacheCleared", () => {});
    expect(sent()).toEqual([]);
    const offFirst = cache.on("cacheChanged", first);
    expect(sent()).toEqual([["subscribe", { cacheId: id }]]);
    const offSecond = cache.on("cacheChanged", second);
    offFirst();
    offFirst();
    expect(sent()).toEqual([["subscribe", { cacheId: id }]]);
    const offEvery = client.on("cacheChanged", every);
    client.on("cacheChanged", every);
    expect(sent()).toEqual([
      ["subscribe", { cacheId: id }],
      ["subscribe", { all: true }],
    ]);

    // The event arrives before the put resolves (N75).
    await cache.put(batch([13]));
    expect(heard).toEqual([`second ${id}`, `every ${id}`]);

    offSecond();
    client.off("cacheChanged", every);
    offEvery();
    expect(sent()).toEqual([
      ["subscribe", { cacheId: id }],
      ["subscribe", { all: true }],
      ["unsubscribe", { cacheId: id }],
      ["unsubscribe", { all: true }],
    ]);
    await cache.put(batch([23]));
    expect(heard).toEqual([`second ${id}`, `every ${id}`]);
  });
});

describe("M7 subscribe, then read (test 15)", () => {
  it("a change after the subscription is shown by the read or reported after it", async () => {
    const server = new RpcServer(new Engine(), "0.0.0");
    const reader = await wire(server, { fetcher: true });
    const writer = await wire(server);
    await reader.client.request("cache", config);
    const range = { start: 3, end: 23 };
    const read = () =>
      reader.client.request("get", {
        cacheId: id,
        range,
        options: { cacheOnly: true },
      }) as Promise<GetResult>;
    await reader.client.request("subscribe", { cacheId: id });

    // The change lands between the subscription and the read: both.
    await writer.client.request("put", { cacheId: id, batch: batch([13]) });
    expect((await read()).timestamps).toEqual(new Float64Array([13]));
    expect(changes(reader.log)).toHaveLength(1);

    // The change lands after the read: reported after its response.
    let mark = reader.log.length;
    expect((await read()).timestamps).toEqual(new Float64Array([13]));
    await writer.client.request("put", { cacheId: id, batch: batch([23]) });
    await barrier(reader);
    expect(labels(reader.log.slice(mark))).toEqual([
      "res",
      "evt:cacheChanged",
      "res",
    ]);
    expect(changes(reader.log.slice(mark))[0]?.written).toEqual([
      { start: 23, end: 23 },
    ]);

    // The change lands while the reader's fetching read waits on its fetch:
    // reported before that read answers, and the read shows a later state.
    await writer.client.request("invalidate", { cacheId: id, range });
    await barrier(reader);
    const held = holdNextFetch();
    mark = reader.log.length;
    const fetching = reader.client.request("get", {
      cacheId: id,
      range,
    }) as Promise<GetResult>;
    await held.entered;
    await writer.client.request("put", {
      cacheId: id,
      batch: batch([3], [30]),
    });
    held.release();
    const result = await fetching;
    const after = changes(reader.log.slice(mark));
    expect(after.map((c) => c.written)).toEqual([
      [{ start: 3, end: 3 }],
      [range],
    ]);
    expect(labels(reader.log.slice(mark)).at(-1)).toBe("res");
    expect(result.coverage).toEqual([range]);
  });
});

describe("M7 orchestrated fetches and reads (tests 16-17)", () => {
  async function fetching(): Promise<{ a: Wire; b: Wire }> {
    const server = new RpcServer(new Engine(), "0.0.0");
    const a = await wire(server, { fetcher: true });
    const b = await wire(server, { fetcher: true });
    await a.client.request("cache", config);
    await a.client.request("subscribe", { cacheId: id });
    await b.client.request("subscribe", { cacheId: id });
    return { a, b };
  }
  const range = { start: 3, end: 23 };

  it("one event per applied fetch, named by the issuing get, before it resolves; a joined get adds none", async () => {
    const { a, b } = await fetching();
    const held = holdNextFetch();
    const issuing = call(a, "get", { cacheId: id, range });
    await held.entered;
    const joined = b.client.request("get", { cacheId: id, range });
    // b's get is in the server's plan once its own barrier answers.
    await barrier(b);
    held.release();
    const { requestId } = await issuing;
    await joined;
    expect(control().calls).toBe(1);
    const event: Changed = {
      cacheId: id,
      written: [range],
      removed: [],
      cleared: false,
      requestId,
    };
    expect(changes(a.log)).toEqual([event]);
    expect(labels(a.log).slice(-2)).toEqual(["evt:cacheChanged", "res"]);
    expect(changes(b.log)).toEqual([event]);
  });

  it.each(["fail", "auth"] as const)(
    "a fetch ending in %s sends nothing",
    async (mode) => {
      const { a } = await fetching();
      control().mode = mode;
      const result = (await a.client.request("get", {
        cacheId: id,
        range,
      })) as GetResult;
      expect(result.misses.map((m) => m.reason)).toEqual([
        mode === "auth" ? "auth-pending" : "fetch-failed",
      ]);
      if (mode === "auth") {
        // Auth is invalid now: the next read issues no fetch at all.
        await a.client.request("get", { cacheId: id, range });
        expect(control().calls).toBe(1);
      }
      expect(changes(a.log)).toEqual([]);
    },
  );

  it("a fetch dropped by the version fence sends nothing; its second round does", async () => {
    const { a, b } = await fetching();
    const held = holdNextFetch();
    const issuing = call(a, "get", { cacheId: id, range });
    await held.entered;
    const clear = await call(b, "clear", { cacheId: id });
    held.release();
    const { requestId } = await issuing;
    expect(control().calls).toBe(2);
    expect(changes(a.log)).toEqual([
      {
        cacheId: id,
        written: [],
        removed: [],
        cleared: true,
        requestId: clear.requestId,
      },
      {
        cacheId: id,
        written: [range],
        removed: [],
        cleared: false,
        requestId,
      },
    ]);
  });

  it("a cacheOnly get and updateAuth send nothing", async () => {
    const { a } = await fetching();
    await a.client.request("put", { cacheId: id, batch: batch([13]) });
    const mark = a.log.length;
    await a.client.request("get", {
      cacheId: id,
      range,
      options: { cacheOnly: true },
    });
    await a.client.request("updateAuth", { context: { token: "t" } });
    await barrier(a);
    expect(labels(a.log.slice(mark))).toEqual(["res", "res", "res"]);
    expect(control().calls).toBe(0);
  });
});

describe("M7 and the persistence (test 18)", () => {
  it("a deferred op keeps its requestId, and a removal's event precedes its durable answer", async () => {
    let hold: Promise<void> | undefined;
    let durable: Promise<void> = Promise.resolve();
    const persistence: Persistence = {
      open: () => Promise.resolve(),
      durably: (_cacheId, op) => {
        if (hold === undefined) return op();
        return hold.then(() => {
          const result = op();
          return durable.then(() => result);
        });
      },
      clearAll: (clearMemory) => {
        if (hold === undefined) return clearMemory?.();
        return hold.then(() => clearMemory?.());
      },
      flush: () => {},
    };
    const engine = new Engine();
    const server = new RpcServer(engine, "0.0.0", undefined, persistence);
    const a = await wire(server);
    await a.client.request("cache", config);
    await a.client.request("subscribe", { cacheId: id });
    await a.client.request("put", { cacheId: id, batch: batch([13]) });

    let open: () => void = () => {};
    hold = new Promise<void>((resolve) => {
      open = resolve;
    });
    let answer: () => void = () => {};
    durable = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const heard = new Promise<Changed>((resolve) => {
      a.client.on((evt: Evt) => {
        if (evt.event === "cacheChanged") resolve(evt.payload as Changed);
      });
    });
    let settled = false;
    const { requestId, answer: pending } = send(a, "invalidate", {
      cacheId: id,
      range: { start: 13, end: 13 },
    });
    const invalidated = pending.then(() => {
      settled = true;
    });
    open();
    const event = await heard;
    expect(event).toEqual({
      cacheId: id,
      written: [],
      removed: [{ start: 13, end: 13 }],
      cleared: false,
      requestId,
    });
    expect(settled).toBe(false);
    answer();
    await invalidated;

    // clearAll, deferred the same way, names its own request too.
    hold = new Promise<void>((resolve) => {
      open = resolve;
    });
    const mark = a.log.length;
    const clearing = call(a, "clearAll", {});
    open();
    const { requestId: clearId } = await clearing;
    expect(changes(a.log.slice(mark))).toEqual([
      {
        cacheId: id,
        written: [],
        removed: [],
        cleared: true,
        requestId: clearId,
      },
    ]);
  });
});

describe("M7 across versions (test 19)", () => {
  /** A worker from before hello.features, answering every request with ok. */
  function oldWorker(features?: unknown): {
    port: MessagePortLike;
    received: unknown[];
  } {
    const channel = new MessageChannel();
    const received: unknown[] = [];
    channel.port1.addEventListener("message", (e) => {
      const message = e.data as { t: string; id?: number };
      received.push(message);
      if (message.t === "init") channel.port1.postMessage({ t: "init-ok" });
      if (message.t === "req") {
        channel.port1.postMessage({ t: "res", id: message.id, ok: true });
      }
    });
    channel.port1.start();
    channel.port1.postMessage({
      t: "hello",
      protocol: PROTOCOL_VERSION,
      lib: "0.0.0",
      clientId: "c1",
      ...(features === undefined ? {} : { features }),
    });
    open.push({ dispose: () => channel.port1.close() });
    return { port: channel.port2 as MessagePortLike, received };
  }

  it("an old worker gives empty features; subscribing posts nothing and warns once", async () => {
    const worker = oldWorker();
    const port = await PortClient.connect(worker.port);
    open.push(port);
    expect(port.features).toEqual(new Set());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const changes = new ChangeSubscriptions(port);
    const release = changes.hold({ cacheId: id });
    changes.hold({ all: true });
    release();
    await port.request("cache", config);
    const ops = worker.received.flatMap((m) =>
      (m as { t: string }).t === "req" ? [(m as Req).op] : [],
    );
    expect(ops).toEqual(["cache"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("cacheChanged");
  });

  it.each([
    { features: "cacheChanged", known: [] },
    { features: [1, "future"], known: [] },
    { features: ["future", "cacheChanged"], known: ["cacheChanged"] },
  ])("hello.features $features gives $known", async ({ features, known }) => {
    const port = await PortClient.connect(oldWorker(features).port);
    open.push(port);
    expect(port.features).toEqual(new Set(known));
  });

  it("an old client that never subscribes receives no cacheChanged", async () => {
    const server = new RpcServer(new Engine(), "0.0.0");
    const writer = await wire(server);
    await writer.client.request("cache", config);
    // An old client: completes the handshake by hand and only reads.
    const channel = new MessageChannel();
    const seen: { t: string; event?: string; id?: number }[] = [];
    let answered: (id: number) => void = () => {};
    const ready = new Promise<void>((resolve) => {
      channel.port2.addEventListener("message", (e) => {
        const message = e.data as { t: string; event?: string; id?: number };
        seen.push(message);
        if (message.t === "hello") {
          channel.port2.postMessage({ t: "init", protocol: PROTOCOL_VERSION });
        }
        if (message.t === "init-ok") resolve();
        if (message.t === "res") answered(message.id as number);
      });
    });
    channel.port2.start();
    server.attach(channel.port1 as MessagePortLike);
    await ready;
    await writer.client.request("put", { cacheId: id, batch: batch([13]) });
    const barrierDone = new Promise<number>((resolve) => {
      answered = resolve;
    });
    channel.port2.postMessage({ t: "req", id: 1, op: "cache", params: config });
    expect(await barrierDone).toBe(1);
    expect(seen.filter((m) => m.t === "evt")).toEqual([]);
    channel.port2.close();
  });
});

describe("M7 hostings and connection lifetime (tests 20-21)", () => {
  it("in-process clients each hear only their own engine's changes", async () => {
    const first = await createClient({ mode: "in-process" });
    const second = await createClient({ mode: "in-process" });
    open.push(first, second);
    const one = await first.cache(config);
    const two = await second.cache(config);
    const heardOne: Changed[] = [];
    const heardTwo: Changed[] = [];
    one.on("cacheChanged", (c) => heardOne.push(c));
    two.on("cacheChanged", (c) => heardTwo.push(c));
    await one.put(batch([13]));
    expect(heardOne.map((c) => c.written)).toEqual([[{ start: 13, end: 13 }]]);
    // A round trip on the second client's own port: nothing came before it.
    await two.get({ start: 3, end: 23 }, { cacheOnly: true });
    expect(heardTwo).toEqual([]);
  });

  it.each(["dispose", "bye"] as const)(
    "a connection's subscriptions go with it on %s",
    async (how) => {
      const engine = new Engine();
      const report = vi.fn();
      // Called whenever any observer has a reader: here, only the server.
      observeCaches(engine, {
        onChange: () => {},
        onMutate: () => {},
        onReaderChange: report,
      });
      const server = new RpcServer(engine, "0.0.0");
      const reader = await wire(server);
      const writer = await wire(server);
      await writer.client.request("cache", config);
      await reader.client.request("subscribe", { cacheId: id });
      await reader.client.request("subscribe", { all: true });
      await writer.client.request("put", { cacheId: id, batch: batch([3]) });
      expect(report).toHaveBeenCalledTimes(1);

      if (how === "dispose") reader.client.dispose();
      else server.detach(reader.port);
      await vi.waitFor(() => expect(server.connections).toBe(1), {
        timeout: 4000,
        interval: 1,
      });
      await writer.client.request("put", { cacheId: id, batch: batch([13]) });
      expect(report).toHaveBeenCalledTimes(1);
    },
  );
});
