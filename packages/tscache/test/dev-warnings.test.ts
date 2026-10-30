import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, type TscacheClient } from "../src/client/client";
import { warnMerges } from "../src/client/dev";
import { Engine } from "../src/engine/engine";
import type { MessagePortLike } from "../src/rpc/protocol";
import { RpcServer } from "../src/rpc/server";
import type { ClientEvents, PutBatch } from "../src/types";

// Implementer tests (architecture §2.7, resolved decision #8): merge
// warnings are also printed with console.warn in development builds, once
// per put, in the page that made the write.

const config = {
  id: "w",
  interval: 10,
  alignmentOffset: 3,
  fields: { price: "f64" },
  warnOnOverlapDiff: true,
} as const;

const batch = (timestamps: number[], prices = timestamps): PutBatch => ({
  timestamps,
  fields: { price: prices },
});

/** Two tabs on one SharedWorker: every client connects to the same server. */
function installSharedWorker(): void {
  const server = new RpcServer(new Engine(), "0.0.0");
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

const clients: TscacheClient[] = [];
async function make(options: Parameters<typeof createClient>[0]) {
  const client = await createClient(options);
  clients.push(client);
  return client;
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 10));

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("NODE_ENV", "development");
});
afterEach(async () => {
  for (const c of clients.splice(0)) await c.dispose();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("put in a development build", () => {
  it("prints one console.warn per put, naming the cache and every range with its fields", async () => {
    const client = await make({ mode: "in-process" });
    const cache = await client.cache(config);
    await cache.put(batch([3, 13, 23, 33, 43]));
    const { warnings } = await cache.put(
      batch([3, 13, 23, 33, 43], [0, 13, 0, 0, 43]),
    );
    expect(warnings).toEqual([
      { range: { start: 3, end: 3 }, fields: ["price"] },
      { range: { start: 23, end: 33 }, fields: ["price"] },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'tscache: a put to cache "w" overwrote cached values that differed: [3, 3] price; [23, 33] price. Reported because warnOnOverlapDiff is on, also as mergeWarning events; printed in development builds only.',
    );
  });

  it("prints nothing when the put has no warnings", async () => {
    const client = await make({ mode: "in-process" });
    const watched = await client.cache(config);
    const unwatched = await client.cache({
      ...config,
      id: "off",
      warnOnOverlapDiff: false,
    });
    await watched.put(batch([3, 13]));
    expect(await watched.put(batch([3, 13]))).toEqual({ warnings: [] });
    await unwatched.put(batch([3, 13]));
    expect(await unwatched.put(batch([3, 13], [0, 0]))).toEqual({
      warnings: [],
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("prints once, in the tab that put: not in another tab, nor on the server side", async () => {
    installSharedWorker();
    const a = await make({ workerUrl: "/worker.js" });
    const b = await make({ workerUrl: "/worker.js" });
    expect([a.mode, b.mode]).toEqual(["shared", "shared"]);
    const cacheA = await a.cache(config);
    const cacheB = await b.cache(config);
    const heardB: ClientEvents["mergeWarning"][] = [];
    cacheB.on("mergeWarning", (e) => heardB.push(e));
    await cacheA.put(batch([3]));
    await cacheA.put(batch([3], [0]));
    await settled();
    // The event reached the other tab; the console line did not repeat.
    expect(heardB).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("an Engine called directly returns the warnings and prints nothing", () => {
    const engine = new Engine();
    engine.cache(config);
    engine.put("w", batch([3]));
    expect(engine.put("w", batch([3], [0])).warnings).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("put in a production build", () => {
  it("prints nothing, while the result and the event still carry the warning", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const client = await make({ mode: "in-process" });
    const cache = await client.cache(config);
    const heard: ClientEvents["mergeWarning"][] = [];
    cache.on("mergeWarning", (e) => heard.push(e));
    await cache.put(batch([3]));
    expect((await cache.put(batch([3], [0]))).warnings).toHaveLength(1);
    await settled();
    expect(heard).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("an unbundled page without `process` counts as production and does not throw", () => {
    vi.stubGlobal("process", undefined);
    try {
      warnMerges("w", [{ range: { start: 3, end: 3 }, fields: ["price"] }]);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(warn).not.toHaveBeenCalled();
  });
});
