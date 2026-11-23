import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient, type TscacheClient } from "../src/client/client";
import { Engine } from "../src/engine/engine";
import { TscacheError } from "../src/errors";
import { PortClient } from "../src/rpc/port-client";
import {
  type Evt,
  LIB_VERSION,
  type MessagePortLike,
  type Op,
  type Req,
  WORKER_FEATURES,
} from "../src/rpc/protocol";
import { RpcServer } from "../src/rpc/server";
import type { CacheConfig, ClientEvents } from "../src/types";
import { PAGE_BYTES } from "./m3-memory-helpers";
import { deferred } from "./persist-memory-store";

// Implementer tests for decision concern DC4 of docs/design/m5-deploy-skew.md
// §8, built with its option (a) (test 30 of §6; architecture §2.7, §4.8;
// N101, N103, N132): a superseded event that reaches a port before its
// client exists is kept by the port client, client.superseded is set when
// createClient resolves, and the event follows on the next macrotask, as
// modeFallback does. Each order of arrival is made by the server-side port,
// never by a pause (docs/testing.md, Waiting).

const workerUrl = "/dist/worker.js";
const plain: CacheConfig = { id: "plain", interval: 1, fields: { v: "f64" } };
const payload = { lib: "9.9.9" };
const open: TscacheClient[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const client of open.splice(0)) await client.dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const eventually = (assertion: () => unknown) =>
  vi.waitFor(assertion, { timeout: 4000, interval: 1 });

interface TapOptions {
  /** Holds the answer to this op until `release`. */
  hold?: Op;
  /** Runs right after the answer to this op has been posted. */
  afterAnswer?: { op: Op; run: () => void };
}

/**
 * A server-side port that names what the server posts, in order, and can
 * hold the answer to one op or act right after posting it.
 */
function tap(port: MessagePort, options: TapOptions) {
  const sent: string[] = [];
  const ops = new Map<number, Op>();
  const held: (() => void)[] = [];
  const arrived = deferred<void>();
  let holding = options.hold !== undefined;
  const wrapped: MessagePortLike = {
    postMessage: (m: unknown, t?: Transferable[]) => {
      const message = m as { t?: string; id?: number; event?: string };
      const op =
        message.t === "res" ? ops.get(message.id as number) : undefined;
      const label =
        op !== undefined
          ? `res:${op}`
          : message.t === "evt"
            ? `evt:${String(message.event)}`
            : String(message.t);
      const send = () => {
        sent.push(label);
        port.postMessage(m, t ?? []);
        if (op !== undefined && op === options.afterAnswer?.op) {
          options.afterAnswer.run();
        }
      };
      if (holding && op !== undefined && op === options.hold) held.push(send);
      else send();
    },
    addEventListener: (type, fn) =>
      port.addEventListener(type, (event) => {
        const message = (event as MessageEvent).data as Req;
        if (type === "message" && message?.t === "req") {
          ops.set(message.id, message.op);
        }
        (fn as EventListener)(event);
        // After the server has handled it: its answer is held by now.
        if (message?.t === "req" && message.op === options.hold) {
          arrived.resolve();
        }
      }),
    removeEventListener: () => {},
    start: () => port.start(),
    close: () => port.close(),
  };
  return {
    wrapped,
    sent,
    arrived: arrived.promise,
    release: () => {
      holding = false;
      for (const send of held.splice(0)) send();
    },
  };
}

/** One SharedWorker behind every tab, each connection through a tap. */
function installSharedWorker(server: RpcServer, options: TapOptions = {}) {
  const taps: ReturnType<typeof tap>[] = [];
  const first = deferred<ReturnType<typeof tap>>();
  vi.stubGlobal("Worker", undefined);
  vi.stubGlobal(
    "SharedWorker",
    class {
      port: unknown;
      constructor() {
        const channel = new MessageChannel();
        const tapped = tap(channel.port1, options);
        taps.push(tapped);
        first.resolve(tapped);
        server.attach(tapped.wrapped);
        this.port = channel.port2;
      }
      addEventListener() {}
      removeEventListener() {}
    },
  );
  return { taps, first: first.promise };
}

/**
 * No SharedWorker, and a dedicated worker whose server is `server`, each
 * connection through a tap.
 */
function installDedicatedWorker(server: RpcServer) {
  const taps: ReturnType<typeof tap>[] = [];
  vi.stubGlobal("SharedWorker", undefined);
  vi.stubGlobal("Worker", function FakeWorker() {
    const channel = new MessageChannel();
    const tapped = tap(channel.port1, {});
    taps.push(tapped);
    server.attach(tapped.wrapped);
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
  return { taps };
}

async function make(
  options: Parameters<typeof createClient>[0],
): Promise<TscacheClient> {
  const client = await createClient(options);
  open.push(client);
  return client;
}

/** A listener attached in the same turn as `await createClient()`. */
function listen(client: TscacheClient) {
  const heard: unknown[] = [];
  client.on("superseded", (event) => heard.push([event, client.superseded]));
  return heard;
}

/**
 * Once the event has been delivered: a round trip later the listener has
 * still been called once, and one attached now is not called and reads the
 * property.
 */
async function deliveredOnce(
  client: TscacheClient,
  heard: unknown[],
): Promise<void> {
  await eventually(() => expect(heard).toEqual([[payload, payload]]));
  const late = vi.fn();
  client.on("superseded", late);
  await client.cache(plain);
  await client.cache(plain);
  expect(heard).toEqual([[payload, payload]]);
  expect(late).not.toHaveBeenCalled();
  expect(client.superseded).toEqual(payload);
}

describe("30: the superseded event before the client exists (DC4 option (a))", () => {
  it("a worker already superseded sends it after init-ok and before the budget answer; the client has the property and delivers the event on the next macrotask", async () => {
    const server = new RpcServer(new Engine(), LIB_VERSION);
    server.supersede(payload);
    const { taps } = installSharedWorker(server);
    const client = await make({ workerUrl, memoryBudget: 4 * PAGE_BYTES });
    // Resolved with the property set, and nothing delivered in this turn.
    expect(client.superseded).toEqual(payload);
    const heard = listen(client);
    expect(heard).toEqual([]);
    expect(taps[0]?.sent).toEqual([
      "hello",
      "init-ok",
      "evt:superseded",
      "res:memoryBudget",
    ]);
    // Being superseded neither failed nor delayed the budget: it is in force.
    expect((await client.memoryStats()).budget).toBe(4 * PAGE_BYTES);
    await deliveredOnce(client, heard);
  });

  it("delivers it after the fallback chain's steps", async () => {
    const server = new RpcServer(new Engine(), LIB_VERSION);
    server.supersede(payload);
    installDedicatedWorker(server);
    const client = await make({ workerUrl, memoryBudget: 4 * PAGE_BYTES });
    expect(client.mode).toBe("dedicated");
    expect(client.superseded).toEqual(payload);
    const order: string[] = [];
    client.on("modeFallback", (step: ClientEvents["modeFallback"]) =>
      order.push(`modeFallback:${step.to}`),
    );
    client.on("superseded", () => order.push("superseded"));
    expect(order).toEqual([]);
    await eventually(() =>
      expect(order).toEqual(["modeFallback:dedicated", "superseded"]),
    );
  });

  it("a listener that throws does not keep the event from the others, and its error is reported", async () => {
    const server = new RpcServer(new Engine(), LIB_VERSION);
    server.supersede(payload);
    installDedicatedWorker(server);
    const reported: unknown[] = [];
    vi.stubGlobal("reportError", (error: unknown) => reported.push(error));
    const client = await make({ workerUrl, memoryBudget: 4 * PAGE_BYTES });
    const failure = new Error("listener failed");
    client.on("modeFallback", () => {
      throw failure;
    });
    const heard = listen(client);
    await eventually(() => {
      expect(heard).toEqual([[payload, payload]]);
      expect(reported).toEqual([failure]);
    });
  });

  it("without a budget the same listener is called once and the property is set", async () => {
    // As the SharedWorker that finds generations does: only a server that
    // lists 'superseded' can send it (ServerOptions.features, N132).
    const server = new RpcServer(
      new Engine(),
      LIB_VERSION,
      undefined,
      undefined,
      {
        features: WORKER_FEATURES,
      },
    );
    server.supersede(payload);
    const { taps } = installSharedWorker(server);
    const client = await make({ workerUrl });
    // Resolved with the property set (DC4 option (a)), before any listener.
    expect(client.superseded).toEqual(payload);
    const heard = listen(client);
    expect(heard).toEqual([]);
    await deliveredOnce(client, heard);
    expect(taps[0]?.sent.slice(0, 3)).toEqual([
      "hello",
      "init-ok",
      "evt:superseded",
    ]);
  });

  it("superseded while the budget op is in flight, the event first: kept, the property set at resolve, delivered once", async () => {
    const server = new RpcServer(new Engine(), LIB_VERSION);
    const { first } = installSharedWorker(server, { hold: "memoryBudget" });
    const creating = createClient({ workerUrl, memoryBudget: 4 * PAGE_BYTES });
    const tapped = await first;
    await tapped.arrived;
    // The connection is ready and its budget answer is held: the event
    // overtakes it.
    server.supersede(payload);
    tapped.release();
    const client = await creating;
    open.push(client);
    expect(tapped.sent).toEqual([
      "hello",
      "init-ok",
      "evt:superseded",
      "res:memoryBudget",
    ]);
    expect(client.superseded).toEqual(payload);
    const heard = listen(client);
    expect(heard).toEqual([]);
    await deliveredOnce(client, heard);
  });

  it("superseded while the budget op is in flight, the answer first: the event arrives live, sets the property and is not replayed", async () => {
    const server = new RpcServer(new Engine(), LIB_VERSION);
    const { taps } = installSharedWorker(server, {
      afterAnswer: { op: "memoryBudget", run: () => server.supersede(payload) },
    });
    const client = await make({ workerUrl, memoryBudget: 4 * PAGE_BYTES });
    // The answer came first: nothing was kept, and the client says so.
    expect(client.superseded).toBeUndefined();
    const heard = listen(client);
    expect(taps[0]?.sent).toEqual([
      "hello",
      "init-ok",
      "res:memoryBudget",
      "evt:superseded",
    ]);
    await deliveredOnce(client, heard);
  });

  // Architecture §2.7: after workerLost or dispose() no event arrives. The
  // kept event waits for a 0 ms timer, so these tests fake setTimeout and
  // run it only once the client has ended. A promise waits for workerLost:
  // vi.waitFor advances fake timers and would run the delivery first.
  it("a worker lost before the delivery: workerLost is heard, and the kept event never is", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const server = new RpcServer(new Engine(), LIB_VERSION);
    server.supersede(payload);
    const { taps } = installSharedWorker(server);
    const client = await make({ workerUrl, memoryBudget: 4 * PAGE_BYTES });
    expect(client.superseded).toEqual(payload);
    const order: string[] = [];
    const lost = new Promise<void>((resolve) =>
      client.on("workerLost", () => {
        order.push("workerLost");
        resolve();
      }),
    );
    client.on("superseded", () => order.push("superseded"));
    taps[0]?.wrapped.postMessage({ t: "bye" });
    await lost;
    vi.runAllTimers();
    vi.useRealTimers();
    expect(order).toEqual(["workerLost"]);
  });

  it("a client disposed right after createClient never delivers the kept event", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const server = new RpcServer(new Engine(), LIB_VERSION);
    server.supersede(payload);
    installSharedWorker(server);
    const client = await make({ workerUrl, memoryBudget: 4 * PAGE_BYTES });
    const heard = listen(client);
    await client.dispose();
    vi.runAllTimers();
    vi.useRealTimers();
    expect(heard).toEqual([]);
  });

  it("a modeFallback listener that disposes the client stops the kept event", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const server = new RpcServer(new Engine(), LIB_VERSION);
    server.supersede(payload);
    installDedicatedWorker(server);
    const client = await make({ workerUrl, memoryBudget: 4 * PAGE_BYTES });
    expect(client.mode).toBe("dedicated");
    const order: string[] = [];
    client.on("modeFallback", (step: ClientEvents["modeFallback"]) => {
      order.push(`modeFallback:${step.to}`);
      void client.dispose();
    });
    client.on("superseded", () => order.push("superseded"));
    vi.runAllTimers();
    vi.useRealTimers();
    expect(order).toEqual(["modeFallback:dedicated"]);
  });

  it("without a budget, one answer is awaited only from a worker that lists 'superseded'", async () => {
    const listing = new RpcServer(
      new Engine(),
      LIB_VERSION,
      undefined,
      undefined,
      {
        features: WORKER_FEATURES,
      },
    );
    const first = installSharedWorker(listing);
    const current = await make({ workerUrl });
    expect(current.superseded).toBeUndefined();
    expect(first.taps[0]?.sent).toEqual([
      "hello",
      "init-ok",
      "res:unsubscribe",
    ]);
    const older = installSharedWorker(new RpcServer(new Engine(), LIB_VERSION));
    const client = await make({ workerUrl });
    expect(client.features.has("superseded")).toBe(false);
    expect(older.taps[0]?.sent).toEqual(["hello", "init-ok"]);
  });

  it("without a budget, a port that goes before the answer rejects createClient", async () => {
    const server = new RpcServer(
      new Engine(),
      LIB_VERSION,
      undefined,
      undefined,
      {
        features: WORKER_FEATURES,
      },
    );
    const { first } = installSharedWorker(server, { hold: "unsubscribe" });
    const creating = createClient({ workerUrl }).then(
      (client) => {
        open.push(client);
        return client;
      },
      (error: unknown) => error,
    );
    const tapped = await first;
    await tapped.arrived;
    tapped.wrapped.postMessage({ t: "bye" });
    expect(await creating).toBeInstanceOf(TscacheError);
  });

  it("a worker that is never superseded delivers nothing", async () => {
    const server = new RpcServer(new Engine(), LIB_VERSION);
    installSharedWorker(server);
    const client = await make({ workerUrl, memoryBudget: 4 * PAGE_BYTES });
    const heard = listen(client);
    await client.cache(plain);
    await client.cache(plain);
    expect(heard).toEqual([]);
    expect(client.superseded).toBeUndefined();
  });
});

// Gate round 6 of step 135 (R6-1, R6-2), the class: every event a port
// receives before its client takes over is kept and delivered once, in port
// order, on the macrotask after `createClient` resolves; a budgetless join
// waits for a constant-cost acknowledgement (`unsubscribe { all: true }`).

/** Every event a worker can post on a port, one of each, in this order. */
const startupEvents: { name: keyof ClientEvents; evt: Evt }[] = [
  {
    name: "authInvalid",
    evt: {
      t: "evt",
      scope: "client",
      event: "authInvalid",
      payload: { error: { name: "Error", message: "401" }, context: "old" },
    },
  },
  {
    name: "cacheCleared",
    evt: {
      t: "evt",
      scope: "cache",
      cacheId: "plain",
      event: "cacheCleared",
      payload: { cacheId: "plain", reason: "clear-all" },
    },
  },
  {
    name: "superseded",
    evt: { t: "evt", scope: "client", event: "superseded", payload },
  },
  {
    name: "persistStopped",
    evt: {
      t: "evt",
      scope: "cache",
      cacheId: "plain",
      event: "persistStopped",
      payload: { cacheId: "plain", reason: "superseded" },
    },
  },
  {
    name: "cacheChanged",
    evt: {
      t: "evt",
      scope: "cache",
      cacheId: "plain",
      event: "cacheChanged",
      payload: { cacheId: "plain", written: [], removed: [], cleared: false },
    },
  },
  {
    name: "mergeWarning",
    evt: {
      t: "evt",
      scope: "request",
      cacheId: "plain",
      requestId: "c9:1",
      event: "mergeWarning",
      payload: {
        cacheId: "plain",
        requestId: "c9:1",
        range: { start: 0, end: 0 },
        fields: ["v"],
      },
    },
  },
];

/** A fetcher module whose every fetch is refused for its auth. */
const refusingModule = `data:text/javascript,${encodeURIComponent(`
  export default {
    async fetch() {
      const error = new Error("401");
      error.code = "tscache:auth-invalid";
      throw error;
    },
  }; // refusing
`)}`;

/** A server that lists every feature, as the SharedWorker's does. */
const listingServer = (engine = new Engine()) =>
  new RpcServer(engine, LIB_VERSION, undefined, undefined, {
    features: WORKER_FEATURES,
  });

/** Every event name of `startupEvents`, heard in order, with its payload. */
function listenAll(client: TscacheClient) {
  const heard: [string, unknown][] = [];
  for (const { name } of startupEvents) {
    client.on(name, (event: unknown) => heard.push([name, event]));
  }
  return heard;
}

describe("gate round 6: every event before the client takes over (R6-1, R6-2)", () => {
  for (const budget of [undefined, 4 * PAGE_BYTES]) {
    const hold: Op = budget === undefined ? "unsubscribe" : "memoryBudget";
    const variant = budget === undefined ? "without a budget" : "with a budget";

    it(`${variant}, each event posted during the join is heard once, in port order, after the client exists`, async () => {
      const late: Evt = {
        t: "evt",
        scope: "cache",
        cacheId: "late",
        event: "cacheCleared",
        payload: { cacheId: "late", reason: "clear-all" },
      };
      let tapped: ReturnType<typeof tap> | undefined;
      const server = listingServer();
      const { first } = installSharedWorker(server, {
        hold,
        // Posted once the client can exist: it follows the kept ones.
        afterAnswer: {
          op: hold,
          run: () => tapped?.wrapped.postMessage(late),
        },
      });
      const creating = createClient({
        workerUrl,
        ...(budget === undefined ? {} : { memoryBudget: budget }),
      });
      tapped = await first;
      await tapped.arrived;
      for (const { evt } of startupEvents) tapped.wrapped.postMessage(evt);
      tapped.release();
      const client = await creating;
      open.push(client);
      // The property is set from the start; nothing is delivered this turn.
      expect(client.superseded).toEqual(payload);
      const heard = listenAll(client);
      expect(heard).toEqual([]);
      const expected = [
        ...startupEvents.map(({ name, evt }) => [name, evt.payload]),
        ["cacheCleared", late.payload],
      ];
      await eventually(() => expect(heard).toEqual(expected));
      await client.cache(plain);
      await client.cache(plain);
      expect(heard).toEqual(expected);
      expect(tapped.sent.slice(0, 2)).toEqual(["hello", "init-ok"]);
      expect(tapped.sent).toContain(`res:${hold}`);
    });

    it(`${variant}, a tab joining while another tab's fetch is refused hears authInvalid once`, async () => {
      const server = listingServer();
      // The refused tab connects on a port of its own, outside the taps.
      const channel = new MessageChannel();
      server.attach(channel.port1 as MessagePortLike);
      const other = await PortClient.connect(channel.port2 as MessagePortLike, {
        fetcher: { module: refusingModule, context: "old" },
      });
      open.push({ dispose: async () => other.dispose() } as TscacheClient);
      await other.request("cache", plain);
      const { first } = installSharedWorker(server, { hold });
      const creating = createClient({
        workerUrl,
        fetcher: { module: refusingModule, context: "old" },
        ...(budget === undefined ? {} : { memoryBudget: budget }),
      });
      const tapped = await first;
      await tapped.arrived;
      const refused = (await other.request("get", {
        cacheId: "plain",
        range: { start: 0, end: 3 },
        options: {},
      })) as { misses: { reason: string }[] };
      expect(refused.misses.map(({ reason }) => reason)).toEqual([
        "auth-pending",
      ]);
      tapped.release();
      const client = await creating;
      open.push(client);
      const heard: unknown[] = [];
      client.on("authInvalid", (event) => heard.push(event));
      await eventually(() => expect(heard).toHaveLength(1));
      expect(tapped.sent.indexOf("evt:authInvalid")).toBeLessThan(
        tapped.sent.indexOf(`res:${hold}`),
      );
      const handle = await client.cache(plain);
      const read = await handle.get({ start: 0, end: 3 });
      expect(read.misses.map(({ reason }) => reason)).toEqual(["auth-pending"]);
      expect(heard).toHaveLength(1);
    });

    it(`${variant}, kept events are never delivered once the client has ended`, async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const server = listingServer();
      const { first } = installSharedWorker(server, { hold });
      const creating = createClient({
        workerUrl,
        ...(budget === undefined ? {} : { memoryBudget: budget }),
      });
      const tapped = await first;
      await tapped.arrived;
      for (const { evt } of startupEvents) tapped.wrapped.postMessage(evt);
      tapped.release();
      const client = await creating;
      open.push(client);
      const heard = listenAll(client);
      await client.dispose();
      vi.runAllTimers();
      vi.useRealTimers();
      expect(heard).toEqual([]);
    });
  }

  it("a budgetless join is acknowledged by unsubscribe and never calls engine.memoryStats", async () => {
    const engine = new Engine();
    engine.cache(plain);
    const stats = vi.spyOn(engine, "memoryStats");
    const { taps } = installSharedWorker(listingServer(engine));
    const client = await make({ workerUrl });
    expect(taps[0]?.sent).toEqual(["hello", "init-ok", "res:unsubscribe"]);
    await client.cache(plain);
    expect(stats).not.toHaveBeenCalled();
  });

  it("a kept event is delivered after the fallback chain's steps, in port order with the others", async () => {
    const server = listingServer();
    server.supersede(payload);
    installDedicatedWorker(server);
    const client = await make({ workerUrl });
    expect(client.mode).toBe("dedicated");
    const order: string[] = [];
    client.on("modeFallback", (step: ClientEvents["modeFallback"]) =>
      order.push(`modeFallback:${step.to}`),
    );
    client.on("superseded", () => order.push("superseded"));
    await eventually(() =>
      expect(order).toEqual(["modeFallback:dedicated", "superseded"]),
    );
  });
});

// Gate round 7 of step 135 (R7-1, R7-2), the class: the replay holds only
// what reached the port before the client existed, and it is drained once,
// before the port delivers anything else, or by the startup timer if that
// comes first. So the page observes the server's post order, whatever the
// timer does: each test below holds the timer and never runs it until the
// end (a hidden tab's throttled timers, docs/testing.md, Waiting).

/** The answers the page observes in these tests, as `tap` names them. */
const observed = new Set(["res:cache", "res:put", "res:get", "res:clearAll"]);

/** The event names the page listens to here, besides modeFallback. */
const heardEvents: (keyof ClientEvents)[] = [
  "superseded",
  "cacheChanged",
  "mergeWarning",
  "authInvalid",
  "cacheCleared",
];

const overlapping: CacheConfig = {
  ...plain,
  id: "overlap",
  warnOnOverlapDiff: true,
};
const batch = (v: number) => ({
  timestamps: new Float64Array([1]),
  fields: { v: new Float64Array([v]) },
});

describe("gate round 7: the startup replay keeps the port's order (R7-1, R7-2)", () => {
  const variants = [
    {
      name: "a superseded join without a budget",
      budget: undefined,
      fallback: false,
    },
    {
      name: "a superseded join with a memoryBudget",
      // Room for every point these tests write (PAGE_BYTES is a test
      // engine's page, smaller than the default engine's).
      budget: 1 << 20,
      fallback: false,
    },
    {
      name: "a start that stepped down to a dedicated worker",
      budget: undefined,
      fallback: true,
    },
  ];
  for (const { name, budget, fallback } of variants) {
    it(`${name}: with the startup timer held, listener calls and settlements follow the server's post order`, async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "info").mockImplementation(() => {});
      let taps: ReturnType<typeof tap>[];
      if (fallback) {
        // No superseding: a dedicated worker cannot report it.
        ({ taps } = installDedicatedWorker(
          new RpcServer(new Engine(), LIB_VERSION),
        ));
      } else {
        const server = listingServer();
        server.supersede(payload);
        ({ taps } = installSharedWorker(server));
      }
      const client = await make({
        workerUrl,
        fetcher: { module: refusingModule, context: "old" },
        ...(budget === undefined ? {} : { memoryBudget: budget }),
      });
      expect(client.mode).toBe(fallback ? "dedicated" : "shared");
      const page: string[] = [];
      client.on("modeFallback", () => page.push("modeFallback"));
      for (const event of heardEvents) {
        client.on(event, () => page.push(`evt:${event}`));
      }
      const settle = async <T>(op: string, promise: Promise<T>) => {
        const value = await promise;
        page.push(`res:${op}`);
        return value;
      };
      const handle = await settle("cache", client.cache(overlapping));
      await settle("put", handle.put(batch(1)));
      warn.mockClear();
      // Overwrites a differing value: the worker posts a mergeWarning for
      // this put before its answer, and the page prints it once, as a put.
      await settle("put", handle.put(batch(2)));
      // An orchestrated fetch the fetcher refuses for its auth.
      await settle("get", handle.get({ start: 0, end: 3 }));
      await settle("clearAll", client.clearAll());
      // A last round trip: everything the server posted has arrived.
      await settle("cache", client.cache(plain));
      const posted = (taps[0]?.sent ?? []).filter(
        (label) => label.startsWith("evt:") || observed.has(label),
      );
      const expected = [...(fallback ? ["modeFallback"] : []), ...posted];
      expect(posted).toContain("evt:mergeWarning");
      expect(page).toEqual(expected);
      // The held timer finds nothing left to deliver.
      vi.runAllTimers();
      vi.useRealTimers();
      expect(page).toEqual(expected);
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0]?.[0])).toContain(
        'a put to cache "overlap"',
      );
    });
  }

  it("a modeFallback listener that disposes the client stops the event whose arrival ran the delivery", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { taps } = installDedicatedWorker(
      new RpcServer(new Engine(), LIB_VERSION),
    );
    const client = await make({ workerUrl });
    expect(client.mode).toBe("dedicated");
    const order: string[] = [];
    client.on("modeFallback", () => {
      order.push("modeFallback");
      void client.dispose();
    });
    client.on("cacheCleared", () => order.push("cacheCleared"));
    const disposed = new Promise<void>((resolve) =>
      client.on("modeFallback", () => resolve()),
    );
    taps[0]?.wrapped.postMessage({
      t: "evt",
      scope: "cache",
      cacheId: "plain",
      event: "cacheCleared",
      payload: { cacheId: "plain", reason: "clear-all" },
    } satisfies Evt);
    await disposed;
    vi.runAllTimers();
    vi.useRealTimers();
    expect(order).toEqual(["modeFallback"]);
  });

  it("each kept event reports its own first listener error, and the replay goes on", async () => {
    const reported: unknown[] = [];
    vi.stubGlobal("reportError", (error: unknown) => reported.push(error));
    const { first } = installSharedWorker(listingServer(), {
      hold: "unsubscribe",
    });
    const creating = createClient({ workerUrl });
    const tapped = await first;
    await tapped.arrived;
    const cleared = (cacheId: string): Evt => ({
      t: "evt",
      scope: "cache",
      cacheId,
      event: "cacheCleared",
      payload: { cacheId, reason: "clear-all" },
    });
    tapped.wrapped.postMessage(cleared("a"));
    tapped.wrapped.postMessage(cleared("b"));
    tapped.release();
    const client = await creating;
    open.push(client);
    const errors = [new Error("listener failed on a"), new Error("on b")];
    const calls: string[] = [];
    client.on("cacheCleared", ({ cacheId }) => {
      calls.push(cacheId);
      throw errors[calls.length - 1];
    });
    await eventually(() => {
      expect(calls).toEqual(["a", "b"]);
      expect(reported).toEqual(errors);
    });
  });
});
