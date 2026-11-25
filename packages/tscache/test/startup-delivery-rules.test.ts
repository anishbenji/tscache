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
