import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Engine } from "../src/engine/engine";
import type { MessagePortLike } from "../src/rpc/protocol";
import { RpcServer } from "../src/rpc/server";
import type { ClientEvents, PutBatch } from "../src/types";

// Implementer tests (architecture §4.8, step 48): the in-process hosting is
// a module the client loads with import() only when the chain reaches it.
// The mock is the module-load seam: registered afresh for each test, its
// factory runs when the module is first loaded, and can make the load fail
// as a chunk that cannot be fetched would.

const loads = { count: 0, failure: undefined as Error | undefined };

const config = {
  id: "c",
  interval: 10,
  alignmentOffset: 3,
  fields: { price: "f64" },
} as const;

const batch = (): PutBatch => ({
  timestamps: new Float64Array([3, 13]),
  fields: { price: new Float64Array([1, 2]) },
});

/** A worker-like object over a MessageChannel served by its own engine. */
function served(): MessagePort {
  const channel = new MessageChannel();
  new RpcServer(new Engine(), "0.0.0").attach(channel.port1 as MessagePortLike);
  return channel.port2;
}

function installSharedWorker(): void {
  vi.stubGlobal(
    "SharedWorker",
    class {
      port = served();
      addEventListener() {}
      removeEventListener() {}
    },
  );
}

function installDedicatedWorker(): void {
  // A constructor function, not a class: it returns a plain object with the
  // Worker surface.
  vi.stubGlobal("Worker", function FakeWorker() {
    const port = served();
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

/** createClient from a fresh module registry, so the seam counts this test. */
async function load() {
  return (await import("../src/client/client")).createClient;
}

const clients: { dispose(): Promise<void> }[] = [];

beforeEach(() => {
  vi.resetModules();
  loads.count = 0;
  loads.failure = undefined;
  vi.doMock(import("../src/client/in-process"), async (importOriginal) => {
    loads.count++;
    if (loads.failure !== undefined) throw loads.failure;
    return importOriginal();
  });
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.dispose();
  vi.unstubAllGlobals();
});

/** A client's put and get work end to end. */
async function roundTrip(
  client: Awaited<ReturnType<Awaited<ReturnType<typeof load>>>>,
) {
  const cache = await client.cache(config);
  await cache.put(batch());
  const got = await cache.get({ start: 3, end: 13 });
  expect(Array.from(got.timestamps)).toEqual([3, 13]);
}

describe("the in-process hosting is loaded only when used", () => {
  it("a SharedWorker client never loads it", async () => {
    installSharedWorker();
    installDedicatedWorker();
    const createClient = await load();
    const client = await createClient({ workerUrl: "/w.js" });
    clients.push(client);
    expect(client.mode).toBe("shared");
    await roundTrip(client);
    expect(loads.count).toBe(0);
  });

  it("a dedicated-worker client never loads it", async () => {
    installDedicatedWorker();
    vi.stubGlobal("SharedWorker", undefined);
    const createClient = await load();
    const client = await createClient({ workerUrl: "/w.js" });
    clients.push(client);
    expect(client.mode).toBe("dedicated");
    await roundTrip(client);
    expect(loads.count).toBe(0);
  });

  it("the in-process pin loads it and works", async () => {
    const createClient = await load();
    const client = await createClient({ mode: "in-process" });
    clients.push(client);
    expect(client.mode).toBe("in-process");
    await roundTrip(client);
    expect(loads.count).toBe(1);
  });

  it("falling back to in-process loads it and works", async () => {
    vi.stubGlobal("SharedWorker", undefined);
    vi.stubGlobal("Worker", undefined);
    const createClient = await load();
    const client = await createClient({ workerUrl: "/w.js" });
    clients.push(client);
    const seen: ClientEvents["modeFallback"][] = [];
    client.on("modeFallback", (e) => seen.push(e));
    expect(client.mode).toBe("in-process");
    await roundTrip(client);
    expect(loads.count).toBe(1);
    // Delivered on a later macrotask (client.ts).
    await vi.waitFor(
      () => expect(seen.map((s) => s.to)).toEqual(["dedicated", "in-process"]),
      { timeout: 4000, interval: 1 },
    );
  });

  it("a second in-process client reuses the loaded module", async () => {
    const createClient = await load();
    clients.push(await createClient({ mode: "in-process" }));
    clients.push(await createClient({ mode: "in-process" }));
    expect(loads.count).toBe(1);
  });
});

describe("a chunk that fails to load fails the hosting", () => {
  it("the in-process pin rejects with a TscacheError naming the load", async () => {
    loads.failure = new TypeError(
      "Failed to fetch dynamically imported module",
    );
    const createClient = await load();
    const rejected = await createClient({ mode: "in-process" }).then(
      () => undefined,
      (error: unknown) => error,
    );
    // The class of this test's module registry, which load() started.
    const { TscacheError } = await import("../src/errors");
    expect(rejected).toBeInstanceOf(TscacheError);
    // Vitest wraps the factory's error, and a browser rejects the import()
    // with a TypeError of its own: either follows the prefix.
    expect((rejected as Error).message).toMatch(
      /^the in-process hosting could not be loaded: \S/,
    );
  });

  it("at the end of the chain it rejects createClient the same way", async () => {
    vi.stubGlobal("SharedWorker", undefined);
    vi.stubGlobal("Worker", undefined);
    loads.failure = new TypeError(
      "Failed to fetch dynamically imported module",
    );
    const createClient = await load();
    await expect(createClient({ workerUrl: "/w.js" })).rejects.toThrow(
      /in-process hosting could not be loaded/,
    );
  });
});
