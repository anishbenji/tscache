import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient, type TscacheClient } from "../src/client/client";
import { Engine } from "../src/engine/engine";
import {
  LIB_VERSION,
  type MessagePortLike,
  type Op,
  type Req,
} from "../src/rpc/protocol";
import { RpcServer } from "../src/rpc/server";
import type { CacheConfig, ClientEvents } from "../src/types";
import { PAGE_BYTES } from "./m3-memory-helpers";
import { deferred } from "./persist-memory-store";

// Implementer tests for decision concern DC4 of docs/design/m5-deploy-skew.md
// §8, built with its option (a) (test 30 of §6; architecture §2.7, §4.8;
// N101, N103, N113): a superseded event that reaches a port before its
// client exists is kept by the port client, client.superseded is set when
// createClient resolves, and the event follows on the next macrotask, as
// modeFallback does. Each order of arrival is made by the server-side port,
// never by a pause (docs/testing.md, Waiting).

const workerUrl = "/dist/worker.js";
const plain: CacheConfig = { id: "plain", interval: 1, fields: { v: "f64" } };
const payload = { lib: "9.9.9" };
const open: TscacheClient[] = [];

afterEach(async () => {
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

/** No SharedWorker, and a dedicated worker whose server is `server`. */
function installDedicatedWorker(server: RpcServer): void {
  vi.stubGlobal("SharedWorker", undefined);
  vi.stubGlobal("Worker", function FakeWorker() {
    const channel = new MessageChannel();
    server.attach(channel.port1 as MessagePortLike);
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
    const server = new RpcServer(new Engine(), LIB_VERSION);
    server.supersede(payload);
    const { taps } = installSharedWorker(server);
    const client = await make({ workerUrl });
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
