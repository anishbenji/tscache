import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient, type TscacheClient } from "../src/client/client";
import { Engine } from "../src/engine/engine";
import { ConfigError, TscacheError } from "../src/errors";
import {
  LIB_VERSION,
  type MessagePortLike,
  PROTOCOL_VERSION,
  type Req,
} from "../src/rpc/protocol";
import { RpcServer } from "../src/rpc/server";
import type { CacheConfig } from "../src/types";
import { deferred } from "./persist-memory-store";
import { tracked } from "./persist-test-helpers";

// Implementer tests for M3 over the client (design §5 tests 16-17;
// architecture §2.9, §3.2, N101, N103). Each absence is proved by a held
// answer or a later answer on the same port, never a pause
// (docs/testing.md, Waiting).

const url = "/dist/worker.js";
const open: TscacheClient[] = [];

afterEach(async () => {
  for (const client of open.splice(0)) await client.dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function config(id: string): CacheConfig {
  return { id, interval: 1, fields: { value: "f64" } };
}

async function client(
  options: Parameters<typeof createClient>[0],
): Promise<TscacheClient> {
  const created = await createClient(options);
  open.push(created);
  return created;
}

/**
 * A server-side port that records the requests it receives and can hold
 * the answer to one op until the test releases it, or answer `fail` with
 * an error instead of the server's answer.
 */
function watched(port: MessagePort, hold?: Req["op"], fail?: Req["op"]) {
  const received: Req[] = [];
  const arrived = deferred<void>();
  const held: (() => void)[] = [];
  let holding = hold !== undefined;
  const ids = new Set<number>();
  const failing = new Set<number>();
  const wrapped: MessagePortLike = {
    postMessage: (m: unknown, t?: Transferable[]) => {
      const send = () => port.postMessage(m, t ?? []);
      const message = m as { t?: string; id?: number };
      if (message.t === "res" && failing.has(message.id as number)) {
        port.postMessage({
          t: "res",
          id: message.id,
          ok: false,
          error: { name: "TscacheError", message: "budget refused" },
        });
      } else if (
        holding &&
        message.t === "res" &&
        ids.has(message.id as number)
      ) {
        held.push(send);
      } else send();
    },
    addEventListener: (type, fn) =>
      port.addEventListener(type, (event) => {
        const message = (event as MessageEvent).data as Req;
        if (type === "message" && message?.t === "req") {
          received.push(message);
          if (message.op === hold) {
            ids.add(message.id);
            arrived.resolve();
          }
          if (message.op === fail) failing.add(message.id);
        }
        (fn as EventListener)(event);
      }),
    removeEventListener: () => {},
    start: () => port.start(),
    close: () => port.close(),
  };
  return {
    wrapped,
    received,
    arrived: arrived.promise,
    release: () => {
      holding = false;
      for (const send of held.splice(0)) send();
    },
  };
}

/** One SharedWorker for every tab: one engine behind every connection. */
function installSharedWorker(server: RpcServer, hold?: Req["op"]) {
  const watches: ReturnType<typeof watched>[] = [];
  const first = deferred<ReturnType<typeof watched>>();
  vi.stubGlobal("Worker", undefined);
  vi.stubGlobal(
    "SharedWorker",
    class {
      port: unknown;
      constructor() {
        const channel = new MessageChannel();
        const watch = watched(channel.port1, hold);
        watches.push(watch);
        first.resolve(watch);
        server.attach(watch.wrapped);
        this.port = channel.port2;
      }
      addEventListener() {}
      removeEventListener() {}
    },
  );
  return { watches, first: first.promise };
}

/** A dedicated worker per client, each with an engine of its own. */
function installDedicatedWorkers(): Engine[] {
  return installWatchedDedicatedWorkers().engines;
}

/**
 * Dedicated workers as above, whose server ports are watched (`hold` and
 * `fail` as in `watched`), counting how often a worker is terminated.
 */
function installWatchedDedicatedWorkers(hold?: Req["op"], fail?: Req["op"]) {
  const engines: Engine[] = [];
  const watches: ReturnType<typeof watched>[] = [];
  const first = deferred<ReturnType<typeof watched>>();
  const counts = { terminated: 0 };
  vi.stubGlobal("SharedWorker", undefined);
  vi.stubGlobal("Worker", function FakeWorker() {
    const channel = new MessageChannel();
    const engine = new Engine();
    engines.push(engine);
    const watch = watched(channel.port1, hold, fail);
    watches.push(watch);
    first.resolve(watch);
    new RpcServer(engine, LIB_VERSION).attach(watch.wrapped);
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
      terminate: () => {
        counts.terminated++;
        port.close();
      },
    };
  });
  return { engines, watches, first: first.promise, counts };
}

/**
 * A worker from before memory budgets: its hello lists only
 * 'cacheChanged', and it answers ops it does not know with `unknown op`.
 */
function installOlderSharedWorker(): Req[] {
  const received: Req[] = [];
  vi.stubGlobal("Worker", undefined);
  vi.stubGlobal(
    "SharedWorker",
    class {
      port: unknown;
      constructor() {
        const channel = new MessageChannel();
        const worker = channel.port1;
        worker.addEventListener("message", (event) => {
          const message = event.data as Req | { t: "init" };
          if (message.t === "init") worker.postMessage({ t: "init-ok" });
          if (message.t !== "req") return;
          received.push(message);
          worker.postMessage(
            message.op === "memoryBudget" || message.op === "memoryStats"
              ? {
                  t: "res",
                  id: message.id,
                  ok: false,
                  error: {
                    name: "TscacheError",
                    message: `unknown op "${message.op}"`,
                  },
                }
              : // The cache op answers its config, as a resolved one.
                { t: "res", id: message.id, ok: true, result: message.params },
          );
        });
        worker.start();
        worker.postMessage({
          t: "hello",
          protocol: PROTOCOL_VERSION,
          lib: "0.2.0",
          clientId: "c1",
          features: ["cacheChanged"],
        });
        this.port = channel.port2;
      }
      addEventListener() {}
      removeEventListener() {}
    },
  );
  return received;
}

describe("M3 client and ops (design §5 test 16)", () => {
  it("rejects a budget that is not a positive safe integer before connecting", async () => {
    for (const memoryBudget of [0, -1, 1.5, Number.NaN, 2 ** 53]) {
      await expect(
        createClient({ mode: "in-process", memoryBudget }),
      ).rejects.toBeInstanceOf(ConfigError);
    }
  });

  it("createClient resolves only after the worker answered the budget", async () => {
    const engine = new Engine();
    const { first } = installSharedWorker(
      new RpcServer(engine, LIB_VERSION),
      "memoryBudget",
    );
    const pending = tracked(
      createClient({ workerUrl: url, memoryBudget: 4096 }).then((c) => {
        open.push(c);
      }),
    );
    const watch = await first;
    await watch.arrived;
    // The engine took the budget, and its answer is held: still pending.
    expect(engine.memoryStats().budget).toBe(4096);
    expect(pending.done).toBe(false);
    watch.release();
    await pending.promise;
    expect(watch.received.map((r) => r.op)).toEqual(["memoryBudget"]);
  });

  it("the first budget holds; a second client is told the one in force, warns once, and both see every cache", async () => {
    const engine = new Engine();
    installSharedWorker(new RpcServer(engine, LIB_VERSION));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = await client({ workerUrl: url, memoryBudget: 4096 });
    expect(engine.memoryStats().budget).toBe(4096);
    expect(warn).not.toHaveBeenCalled();
    const b = await client({ workerUrl: url, memoryBudget: 8192 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/8192.*4096/);
    await (await a.cache(config("x"))).put({
      timestamps: [0, 1],
      fields: { value: [1, 2] },
    });
    await b.cache(config("y"));
    for (const c of [a, b]) {
      const stats = await c.memoryStats();
      expect(stats.budget).toBe(4096);
      expect(stats.caches.map((row) => row.cacheId)).toEqual(["x", "y"]);
      expect(stats.bytes).toBe(engine.memoryStats().bytes);
      expect(stats.bytes).toBeGreaterThan(0);
    }
  });

  it("a budget that reaches a worker already holding a cache is not applied and warns", async () => {
    const engine = new Engine();
    engine.cache(config("early"));
    installSharedWorker(new RpcServer(engine, LIB_VERSION));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = await client({ workerUrl: url, memoryBudget: 4096 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/already held a cache/);
    expect(await c.memoryStats()).not.toHaveProperty("budget");
  });

  it("an older worker's client resolves without sending the budget, warns once, and memoryStats rejects", async () => {
    const received = installOlderSharedWorker();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = await client({ workerUrl: url, memoryBudget: 4096 });
    expect(c.features.has("memoryBudget")).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/does not offer/);
    await expect(c.memoryStats()).rejects.toBeInstanceOf(TscacheError);
    // An ordered answer on the same port: nothing about memory was sent.
    await c.cache(config("x"));
    expect(received.map((r) => r.op)).toEqual(["cache"]);
  });

  it("without the option nothing about memory is sent, and memoryStats still answers", async () => {
    const engine = new Engine();
    const { watches } = installSharedWorker(new RpcServer(engine, LIB_VERSION));
    const c = await client({ workerUrl: url });
    await c.cache(config("x"));
    expect(watches[0]?.received.map((r) => r.op)).toEqual(["cache"]);
    expect(await c.memoryStats()).toEqual({
      bytes: 0,
      pinnedBytes: 0,
      evictedPages: 0,
      caches: [{ cacheId: "x", bytes: 0, pages: 0 }],
    });
  });
});

describe("M3 client: budget and the client's own start (pre-review 1)", () => {
  it("modeFallback still reaches a listener attached after createClient resolves, with the budget's answer held past a macrotask", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { first } = installWatchedDedicatedWorkers("memoryBudget");
      const pending = tracked(
        createClient({ workerUrl: url, memoryBudget: 4096 }).then((c) => {
          open.push(c);
        }),
      );
      const watch = await first;
      await watch.arrived;
      // A macrotask while the answer is held: a fallback timer queued
      // before the caller holds the client would fire into no listener.
      await vi.advanceTimersByTimeAsync(0);
      expect(pending.done).toBe(false);
      watch.release();
      await pending.promise;
      const c = open.at(-1) as TscacheClient;
      expect(c.mode).toBe("dedicated");
      const seen: unknown[] = [];
      c.on("modeFallback", (e) => seen.push(e));
      await vi.advanceTimersByTimeAsync(0);
      expect(seen).toEqual([
        expect.objectContaining({ from: "shared", to: "dedicated" }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a worker that answers memoryBudget with an error rejects createClient, which releases the port and the worker", async () => {
    const { first, counts } = installWatchedDedicatedWorkers(
      undefined,
      "memoryBudget",
    );
    const error = await createClient({
      workerUrl: url,
      memoryBudget: 4096,
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(TscacheError);
    expect(String((error as Error).message)).toMatch(/budget refused/);
    expect(counts.terminated).toBe(1);
    // The port told the worker it went (a dedicated worker cannot see it).
    const watch = await first;
    await vi.waitFor(() =>
      expect(watch.received.map((r) => r.op)).toEqual([
        "memoryBudget",
        "dispose",
      ]),
    );
  });
});

describe("M3 hostings (design §5 test 17)", () => {
  it("in-process: each client has its own engine, budget and stats", async () => {
    const a = await client({ mode: "in-process", memoryBudget: 4096 });
    const b = await client({ mode: "in-process", memoryBudget: 8192 });
    await (await a.cache(config("x"))).put({
      timestamps: [0],
      fields: { value: [1] },
    });
    expect(await a.memoryStats()).toMatchObject({
      budget: 4096,
      caches: [{ cacheId: "x" }],
    });
    expect(await b.memoryStats()).toEqual({
      budget: 8192,
      bytes: 0,
      pinnedBytes: 0,
      evictedPages: 0,
      caches: [],
    });
  });

  it("dedicated: each tab's worker has its own engine, budget and stats", async () => {
    const engines = installDedicatedWorkers();
    const a = await client({
      workerUrl: url,
      mode: "dedicated",
      memoryBudget: 4096,
    });
    const b = await client({
      workerUrl: url,
      mode: "dedicated",
      memoryBudget: 8192,
    });
    expect(a.mode).toBe("dedicated");
    await a.cache(config("x"));
    expect(engines.map((e) => e.memoryStats().budget)).toEqual([4096, 8192]);
    expect((await a.memoryStats()).caches.map((r) => r.cacheId)).toEqual(["x"]);
    expect((await b.memoryStats()).caches).toEqual([]);
  });
});
