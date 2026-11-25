import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hosting } from "../src/client/hosting";
import { Engine } from "../src/engine/engine";
import { PortClient } from "../src/rpc/port-client";
import {
  type Evt,
  LIB_VERSION,
  type MessagePortLike,
} from "../src/rpc/protocol";
import { RpcServer } from "../src/rpc/server";
import type { ClientEvents } from "../src/types";

// Implementer tests for the startup delivery's own rules (architecture §2.7,
// §4.8; step 135, gate round 8, R8-2). One start, one table: no SharedWorker
// and no Worker, so the chain takes two modeFallback steps to the in-process
// hosting, whose worker posted two events before the client existed, so the
// port kept them. A listener that returns, throws, disposes the client, or
// disposes it and throws, at the first step, the last step and the first
// kept event. Nothing is delivered after the client has ended, and every
// error thrown is reported: the steps' first error once, a kept event's own.
// The delivery runs on a 0 ms timer, faked here and run once listeners are
// on (docs/testing.md, Waiting).

const workerUrl = "/dist/worker.js";

const cleared = (cacheId: string): Evt => ({
  t: "evt",
  scope: "cache",
  cacheId,
  event: "cacheCleared",
  payload: { cacheId, reason: "clear-all" },
});

/** Detaches the server from the latest hosting: its client hears a bye. */
let detachWorker: (() => void) | undefined;

/**
 * The in-process hosting with its own engine, whose server posts two
 * events once the connection is ready: they reach the port before the
 * budget answer, while no client exists, so the port keeps them.
 */
async function inProcessWithKeptEvents(): Promise<Hosting> {
  const channel = new MessageChannel();
  const server = new RpcServer(new Engine(), LIB_VERSION);
  const port = channel.port1 as MessagePortLike;
  server.attach(port);
  detachWorker = () => server.detach(port);
  const client = await PortClient.connect(channel.port2 as MessagePortLike);
  port.postMessage(cleared("a"));
  port.postMessage(cleared("b"));
  return {
    mode: "in-process",
    client,
    terminate: () => server.detach(port),
  };
}

/** createClient from a fresh module registry, with the hosting mocked. */
async function load() {
  return (await import("../src/client/client")).createClient;
}

const clients: { dispose(): Promise<void> }[] = [];

beforeEach(() => {
  vi.resetModules();
  vi.doMock(import("../src/client/in-process"), () => ({
    connectInProcess: inProcessWithKeptEvents,
  }));
  vi.stubGlobal("SharedWorker", undefined);
  vi.stubGlobal("Worker", undefined);
});

afterEach(async () => {
  vi.useRealTimers();
  for (const c of clients.splice(0)) await c.dispose();
  vi.unstubAllGlobals();
  vi.doUnmock("../src/client/in-process");
});

/** Everything the start delivers, in order, when no listener stops it. */
const all = ["step:dedicated", "step:in-process", "kept:a", "kept:b"] as const;
type Position = "step:dedicated" | "step:in-process" | "kept:a";
const positions: { name: string; at: Position }[] = [
  { name: "the first modeFallback step", at: "step:dedicated" },
  { name: "the last modeFallback step", at: "step:in-process" },
  { name: "a kept event", at: "kept:a" },
];
const behaviours = [
  { name: "returns", disposes: false, throws: false },
  { name: "throws", disposes: false, throws: true },
  { name: "disposes the client", disposes: true, throws: false },
  { name: "disposes the client and throws", disposes: true, throws: true },
];

describe("the startup delivery's rules (§2.7): a listener at each position", () => {
  for (const { name: where, at } of positions) {
    for (const { name: does, disposes, throws } of behaviours) {
      it(`at ${where}, a listener that ${does}`, async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        vi.spyOn(console, "info").mockImplementation(() => {});
        const reported: unknown[] = [];
        vi.stubGlobal("reportError", (error: unknown) => reported.push(error));
        const createClient = await load();
        const client = await createClient({ workerUrl, memoryBudget: 1 << 20 });
        clients.push(client);
        expect(client.mode).toBe("in-process");
        const failure = new Error(`listener failed at ${at}`);
        const delivered: string[] = [];
        const heard = (label: string) => {
          delivered.push(label);
          if (label !== at) return;
          if (disposes) void client.dispose();
          if (throws) throw failure;
        };
        client.on("modeFallback", (step: ClientEvents["modeFallback"]) =>
          heard(`step:${step.to}`),
        );
        client.on("cacheCleared", ({ cacheId }) => heard(`kept:${cacheId}`));
        expect(delivered).toEqual([]);
        vi.runAllTimers();
        const end = disposes ? all.indexOf(at) + 1 : all.length;
        expect(delivered).toEqual(all.slice(0, end));
        expect(reported).toEqual(throws ? [failure] : []);
        // Run again: the delivery ran once and nothing follows it.
        vi.runAllTimers();
        expect(delivered).toEqual(all.slice(0, end));
        expect(reported).toEqual(throws ? [failure] : []);
      });
    }
  }
});

/** What `fn` throws, or a marker when it returns. */
function thrownBy(fn: (() => void) | undefined): unknown {
  try {
    fn?.();
  } catch (error) {
    return error;
  }
  return "returned";
}

// The realm without reportError (§2.7, architecture line "thrown from a
// microtask otherwise"; step 135, round 9, user decision #144): a listener
// error that nobody can catch is thrown from a microtask, never at the
// caller whose answer ran the delivery. The 0 ms timer is faked and never
// advanced, so the first RPC response runs the startup delivery; the
// microtasks the client queues are captured, not run, so the test can run
// the one it queued and see what it throws.
describe("without reportError, a listener's synchronous throw (§2.7)", () => {
  const plain = { id: "c", interval: 1, fields: { v: "f64" } } as const;

  it("in the startup delivery's modeFallback steps: the call resolves, one microtask throws it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.stubGlobal("reportError", undefined);
    const createClient = await load();
    const client = await createClient({ workerUrl, memoryBudget: 1 << 20 });
    clients.push(client);
    expect(client.mode).toBe("in-process");
    const failure = new Error("modeFallback listener failed");
    const steps: string[] = [];
    client.on("modeFallback", (step: ClientEvents["modeFallback"]) => {
      steps.push(step.to);
      throw failure;
    });
    const queued: (() => void)[] = [];
    vi.stubGlobal("queueMicrotask", (fn: () => void) => {
      queued.push(fn);
    });
    // The first response runs the startup delivery before it is handled.
    await expect(client.cache(plain)).resolves.toBeDefined();
    expect(steps).toEqual(["dedicated", "in-process"]);
    expect(queued).toHaveLength(1);
    expect(thrownBy(queued[0])).toBe(failure);
    // The delivery ran once: the timer adds nothing.
    vi.runAllTimers();
    expect(steps).toEqual(["dedicated", "in-process"]);
    expect(queued).toHaveLength(1);
  });

  it("in workerLost: the pending call rejects, every listener hears it, one microtask throws it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.stubGlobal("reportError", undefined);
    const createClient = await load();
    const client = await createClient({ workerUrl, memoryBudget: 1 << 20 });
    clients.push(client);
    expect(client.mode).toBe("in-process");
    // The startup delivery runs here, with no listener to throw.
    await client.cache(plain);
    const failure = new Error("workerLost listener failed");
    const heard: string[] = [];
    client.on("workerLost", ({ reason }) => {
      heard.push(`first:${reason}`);
      throw failure;
    });
    client.on("workerLost", ({ reason }) => heard.push(`second:${reason}`));
    const queued: (() => void)[] = [];
    vi.stubGlobal("queueMicrotask", (fn: () => void) => {
      queued.push(fn);
    });
    detachWorker?.();
    await expect(client.memoryStats()).rejects.toMatchObject({
      name: "TscacheError",
      message: "port closed",
    });
    expect(heard).toEqual(["first:port closed", "second:port closed"]);
    expect(queued).toHaveLength(1);
    expect(thrownBy(queued[0])).toBe(failure);
    vi.runAllTimers();
    expect(heard).toEqual(["first:port closed", "second:port closed"]);
    expect(queued).toHaveLength(1);
  });
});
