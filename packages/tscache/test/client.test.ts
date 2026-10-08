import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "../src/client/client";
import { Engine } from "../src/engine/engine";
import {
  ConfigError,
  ProtocolMismatchError,
  TscacheError,
} from "../src/errors";
import type { MessagePortLike } from "../src/rpc/protocol";
import { RpcServer } from "../src/rpc/server";
import type { ClientEvents, GetResult, PutBatch, Range } from "../src/types";

// Implementer tests (architecture §2.1, §4.8): the client facade and the
// fallback chain under Node, with fake Worker/SharedWorker globals that
// speak the real protocol over MessageChannel.

const config = {
  id: "c",
  interval: 10,
  alignmentOffset: 3,
  fields: { price: "f64", volume: "i16" },
} as const;

function batch(timestamps: number[], prices = timestamps): PutBatch {
  return {
    timestamps: new Float64Array(timestamps),
    fields: {
      price: new Float64Array(prices),
      volume: new Int16Array(timestamps),
    },
  };
}

function result(
  timestamps: number[],
  coverage: Range[],
  misses: Range[],
  prices = timestamps,
): GetResult {
  return {
    timestamps: new Float64Array(timestamps),
    fields: {
      price: new Float64Array(prices),
      volume: new Int16Array(timestamps),
    },
    coverage,
    misses: misses.map((range) => ({ range, reason: "uncached" })),
  };
}

/** A port wrapper with the Worker surface: the port plus error events and terminate. */
function workerLike(port: MessagePort, onTerminate: () => void) {
  const errorListeners = new Set<(e: unknown) => void>();
  return {
    postMessage: (m: unknown, t?: Transferable[]) =>
      port.postMessage(m, t ?? []),
    addEventListener: (type: string, fn: (e: never) => void) => {
      if (type === "error") errorListeners.add(fn as (e: unknown) => void);
      else port.addEventListener(type, fn as EventListener);
    },
    removeEventListener: (type: string, fn: (e: never) => void) => {
      if (type === "error") errorListeners.delete(fn as (e: unknown) => void);
      else port.removeEventListener(type, fn as EventListener);
    },
    start: () => port.start(),
    close: () => port.close(),
    terminate: onTerminate,
    fail: (message: string) => {
      for (const fn of errorListeners) fn({ message });
    },
  };
}

/** Fake worker globals backed by one RpcServer per script URL (like a browser). */
function installFakeWorkers(
  opts: { dedicated?: boolean; shared?: boolean } = {},
) {
  const servers = new Map<string, RpcServer>();
  const serverFor = (url: string | URL) => {
    const key = String(url);
    let server = servers.get(key);
    if (server === undefined) {
      server = new RpcServer(new Engine(), "0.0.0");
      servers.set(key, server);
    }
    return server;
  };
  const terminated: string[] = [];
  if (opts.dedicated !== false) {
    // Constructor functions (constructible, unlike arrows), not classes: a
    // fake worker is a plain object with the Worker surface, which a class
    // constructor may not return.
    vi.stubGlobal("Worker", function FakeWorker(url: string | URL) {
      const channel = new MessageChannel();
      // Each dedicated worker is its own engine.
      new RpcServer(new Engine(), "0.0.0").attach(
        channel.port1 as MessagePortLike,
      );
      return workerLike(channel.port2, () => terminated.push(String(url)));
    });
  }
  if (opts.shared !== false) {
    vi.stubGlobal(
      "SharedWorker",
      class {
        port: unknown;
        constructor(url: string | URL) {
          const channel = new MessageChannel();
          serverFor(url).attach(channel.port1 as MessagePortLike);
          this.port = channel.port2;
        }
        addEventListener() {}
        removeEventListener() {}
      },
    );
  }
  return { servers, terminated };
}

const url = "/dist/worker.js";
const clients: { dispose(): Promise<void> }[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.dispose();
  vi.unstubAllGlobals();
});

async function make(options: Parameters<typeof createClient>[0]) {
  const client = await createClient(options);
  clients.push(client);
  return client;
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("createClient options", () => {
  it("requires workerUrl unless pinned in-process", async () => {
    await expect(createClient()).rejects.toBeInstanceOf(ConfigError);
    await expect(createClient({ mode: "dedicated" })).rejects.toBeInstanceOf(
      ConfigError,
    );
    await expect(
      createClient({ workerUrl: url, handshakeTimeoutMs: 0 }),
    ).rejects.toBeInstanceOf(ConfigError);
    await expect(
      createClient({ mode: "nonsense" as never, workerUrl: url }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it("in-process needs no worker and gets its own engine per client", async () => {
    const a = await make({ mode: "in-process" });
    const b = await make({ mode: "in-process" });
    expect(a.mode).toBe("in-process");
    const ca = await a.cache(config);
    await ca.put(batch([3, 13]));
    const cb = await b.cache(config);
    expect(await cb.get({ start: 3, end: 13 })).toEqual(
      result([], [], [{ start: 3, end: 13 }]),
    );
  });
});

describe("fallback chain", () => {
  it("steps shared → dedicated → in-process when no worker API exists, reporting each step", async () => {
    vi.stubGlobal("Worker", undefined);
    vi.stubGlobal("SharedWorker", undefined);
    const client = await make({ workerUrl: url });
    expect(client.mode).toBe("in-process");
    const seen: ClientEvents["modeFallback"][] = [];
    client.on("modeFallback", (e) => seen.push(e));
    await settled();
    expect(seen).toEqual([
      {
        from: "shared",
        to: "dedicated",
        reason: expect.stringMatching(/SharedWorker/),
      },
      {
        from: "dedicated",
        to: "in-process",
        reason: expect.stringMatching(/Worker/),
      },
    ]);
  });

  it("uses the dedicated worker when SharedWorker is missing, and terminates it on dispose", async () => {
    const fakes = installFakeWorkers({ shared: false });
    vi.stubGlobal("SharedWorker", undefined);
    const client = await make({ workerUrl: url });
    expect(client.mode).toBe("dedicated");
    const cache = await client.cache(config);
    await cache.put(batch([3]));
    expect(await cache.get({ start: 3, end: 3 })).toEqual(
      result([3], [{ start: 3, end: 3 }], []),
    );
    await client.dispose();
    await client.dispose();
    expect(fakes.terminated).toEqual([url]);
    await expect(client.cache(config)).rejects.toBeInstanceOf(TscacheError);
  });

  it("shares one engine between clients of the same SharedWorker", async () => {
    installFakeWorkers();
    const a = await make({ workerUrl: url });
    const b = await make({ workerUrl: url });
    expect(a.mode).toBe("shared");
    const ca = await a.cache(config);
    await ca.put(batch([3, 13], [30, 130]));
    const cb = await b.cache(config);
    expect(await cb.get({ start: 3, end: 13 })).toEqual(
      result([3, 13], [{ start: 3, end: 13 }], [], [30, 130]),
    );
    // A clear in one tab is seen in the other.
    const cleared: ClientEvents["cacheCleared"][] = [];
    cb.on("cacheCleared", (e) => cleared.push(e));
    await ca.clear();
    await settled();
    expect(cleared).toEqual([{ cacheId: "c", reason: "manual" }]);
  });

  it("falls back when the worker constructor throws or the script fails to start", async () => {
    vi.stubGlobal(
      "SharedWorker",
      class {
        constructor() {
          throw new Error("blocked by CSP");
        }
      },
    );
    vi.stubGlobal("Worker", function FakeWorker() {
      const channel = new MessageChannel();
      const w = workerLike(channel.port2, () => {});
      setTimeout(() => w.fail("script 404"), 0);
      return w;
    });
    const client = await make({ workerUrl: url });
    expect(client.mode).toBe("in-process");
    const seen: ClientEvents["modeFallback"][] = [];
    client.on("modeFallback", (e) => seen.push(e));
    await settled();
    expect(seen.map((e) => e.reason)).toEqual([
      expect.stringMatching(/blocked by CSP/),
      expect.stringMatching(/script 404/),
    ]);
  });

  it("falls back when a worker never says hello", async () => {
    vi.stubGlobal("SharedWorker", undefined);
    vi.stubGlobal("Worker", function FakeWorker() {
      return workerLike(new MessageChannel().port2, () => {});
    });
    const client = await make({ workerUrl: url, handshakeTimeoutMs: 30 });
    expect(client.mode).toBe("in-process");
  });

  it("a protocol mismatch rejects instead of falling back", async () => {
    vi.stubGlobal(
      "SharedWorker",
      class {
        port: unknown;
        constructor() {
          const channel = new MessageChannel();
          channel.port1.postMessage({
            t: "hello",
            protocol: 99,
            lib: "x",
            clientId: "c1",
          });
          this.port = channel.port2;
        }
        addEventListener() {}
        removeEventListener() {}
      },
    );
    await expect(createClient({ workerUrl: url })).rejects.toBeInstanceOf(
      ProtocolMismatchError,
    );
  });
});

describe("cache handle", () => {
  it("round-trips every op, transfers put buffers and filters events by cache", async () => {
    const client = await make({ mode: "in-process" });
    const a = await client.cache({ ...config, warnOnOverlapDiff: true });
    const b = await client.cache({ ...config, id: "other" });
    const input = batch([3, 13]);
    const prices = input.fields.price as Float64Array;
    await a.put(input, { range: { start: 3, end: 23 } });
    expect(prices.byteLength).toBe(0);
    expect(await a.get({ start: 3, end: 33 })).toEqual(
      result([3, 13], [{ start: 3, end: 23 }], [{ start: 33, end: 33 }]),
    );
    const warningsA: ClientEvents["mergeWarning"][] = [];
    const clearedB: ClientEvents["cacheCleared"][] = [];
    a.on("mergeWarning", (e) => warningsA.push(e));
    b.on("cacheCleared", (e) => clearedB.push(e));
    expect(await a.put(batch([3], [30]))).toEqual({
      warnings: [{ range: { start: 3, end: 3 }, fields: ["price"] }],
    });
    await a.invalidate({ start: 13, end: 13 });
    await a.setFinalizedUntil(23);
    expect(await a.get({ start: 3, end: 23 })).toEqual(
      result(
        [3, 13],
        [{ start: 3, end: 3 }],
        [{ start: 13, end: 23 }],
        [30, 13],
      ),
    );
    await a.clear();
    await client.clearAll();
    await client.updateAuth({ token: "t" });
    await settled();
    expect(warningsA).toEqual([
      {
        cacheId: "c",
        requestId: expect.stringMatching(/^c1:\d+$/),
        range: { start: 3, end: 3 },
        fields: ["price"],
      },
    ]);
    // b hears only its own clear (from clearAll), not a's manual clear.
    expect(clearedB).toEqual([{ cacheId: "other", reason: "clear-all" }]);
  });
});

describe("lifecycle (round 1)", () => {
  it("a SharedWorker that answers after the timeout completes nothing: this side's port is closed", async () => {
    let closed = 0;
    let messages = 0;
    vi.stubGlobal("Worker", undefined);
    vi.stubGlobal(
      "SharedWorker",
      class {
        port: unknown;
        constructor() {
          const channel = new MessageChannel();
          const server = new RpcServer(new Engine(), "0.0.0");
          // Attach late: hello arrives after the client gave up.
          setTimeout(() => server.attach(channel.port1 as MessagePortLike), 60);
          const port = channel.port2;
          this.port = {
            postMessage: (m: unknown, t?: Transferable[]) => {
              messages++;
              port.postMessage(m, t ?? []);
            },
            addEventListener: (type: string, fn: EventListener) =>
              port.addEventListener(type, fn),
            removeEventListener: (type: string, fn: EventListener) =>
              port.removeEventListener(type, fn),
            start: () => port.start(),
            close: () => {
              closed++;
              port.close();
            },
          };
        }
        addEventListener() {}
        removeEventListener() {}
      },
    );
    const client = await make({ workerUrl: url, handshakeTimeoutMs: 20 });
    expect(client.mode).toBe("in-process");
    await new Promise((r) => setTimeout(r, 120));
    // Abandoned on timeout: the port was closed and no init was ever sent.
    expect(closed).toBe(1);
    expect(messages).toBe(0);
  });

  it("a dedicated worker's fatal error after the handshake rejects pending requests", async () => {
    vi.stubGlobal("SharedWorker", undefined);
    let fake: ReturnType<typeof workerLike> | undefined;
    vi.stubGlobal("Worker", function FakeWorker() {
      const channel = new MessageChannel();
      new RpcServer(new Engine(), "0.0.0").attach(
        channel.port1 as MessagePortLike,
      );
      fake = workerLike(channel.port2, () => {});
      // Swallow requests so one stays pending.
      const original = fake.postMessage;
      fake.postMessage = (m: unknown, t?: Transferable[]) => {
        if ((m as { t?: string }).t !== "req") original(m, t);
      };
      return fake;
    });
    const client = await make({ workerUrl: url });
    expect(client.mode).toBe("dedicated");
    const pending = client.clearAll();
    fake?.fail("out of memory");
    await expect(pending).rejects.toMatchObject({
      name: "TscacheError",
      message: expect.stringMatching(/out of memory/),
    });
  });

  it("delivers every fallback step even when a listener throws", async () => {
    vi.stubGlobal("Worker", undefined);
    vi.stubGlobal("SharedWorker", undefined);
    const client = await make({ workerUrl: url });
    const seen: string[] = [];
    client.on("modeFallback", (e) => {
      seen.push(e.to);
      throw new Error("listener failed");
    });
    const reported: unknown[] = [];
    vi.stubGlobal("reportError", (e: unknown) => reported.push(e));
    await settled();
    expect(seen).toEqual(["dedicated", "in-process"]);
    expect(reported).toHaveLength(1);
  });

  it("disposes itself on pagehide, telling the worker", async () => {
    const listeners = new Map<string, (e: unknown) => void>();
    vi.stubGlobal(
      "addEventListener",
      (type: string, fn: (e: unknown) => void) => listeners.set(type, fn),
    );
    vi.stubGlobal("removeEventListener", (type: string) =>
      listeners.delete(type),
    );
    const fakes = installFakeWorkers();
    const client = await make({ workerUrl: url });
    const server = fakes.servers.get(url);
    expect(server?.connections).toBe(1);
    // Into the back/forward cache: the page may return, so nothing changes.
    listeners.get("pagehide")?.({ persisted: true });
    await settled();
    expect(server?.connections).toBe(1);
    await client.clearAll();
    // Really leaving: dispose.
    listeners.get("pagehide")?.({ persisted: false });
    await settled();
    expect(server?.connections).toBe(0);
    await expect(client.clearAll()).rejects.toBeInstanceOf(TscacheError);
    expect(listeners.has("pagehide")).toBe(false);
  });
});
