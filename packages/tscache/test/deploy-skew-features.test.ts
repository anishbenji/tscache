import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient, type TscacheClient } from "../src/client/client";
import { Engine } from "../src/engine/engine";
import { createServer } from "../src/entries/worker";
import { PortClient } from "../src/rpc/port-client";
import {
  type Hello,
  LIB_VERSION,
  type MessagePortLike,
} from "../src/rpc/protocol";
import { RpcServer } from "../src/rpc/server";
import { MemoryStore } from "./persist-memory-store";
import { fakeChannels } from "./workers-channel";

// Implementer tests for decision concern DC2 of docs/design/m5-deploy-skew.md
// §8, built with its option (a) (test 29 of §6; architecture §2.7, §4.7;
// N79, N132): only a worker that takes part in the detection lists
// 'superseded' in hello.features, and a listener on a client whose worker
// does not list it prints no development warning.

const open: { dispose(): unknown }[] = [];
afterEach(async () => {
  for (const item of open.splice(0)) await item.dispose();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const workerUrl = "https://app.example/dist/worker.js";

/** The hello `server` sends, and a client connected to it. */
async function hello(server: RpcServer) {
  const channel = new MessageChannel();
  const hellos: Hello[] = [];
  channel.port2.addEventListener("message", (event) => {
    const data = (event as MessageEvent).data as Hello;
    if (data.t === "hello") hellos.push(data);
  });
  server.attach(channel.port1 as MessagePortLike);
  const client = await PortClient.connect(channel.port2 as MessagePortLike);
  open.push(client);
  return { features: hellos[0]?.features, client };
}

async function make(
  options: Parameters<typeof createClient>[0],
): Promise<TscacheClient> {
  const client = await createClient(options);
  open.push(client);
  return client;
}

describe("29: the 'superseded' feature name (DC2 option (a))", () => {
  it("a SharedWorker's server that takes part in the detection lists it, before any skew", async () => {
    const bus = fakeChannels();
    const store = new MemoryStore();
    const server = createServer(
      undefined,
      async () => store,
      undefined,
      false,
      {
        channel: bus.open(),
        url: workerUrl,
        startedAt: 1,
      },
    );
    const { features, client } = await hello(server);
    expect(features).toEqual([
      "cacheChanged",
      "memoryBudget",
      "superseded",
      "calendar-grid",
    ]);
    expect([...client.features].sort()).toEqual([
      "cacheChanged",
      "calendar-grid",
      "memoryBudget",
      "superseded",
    ]);

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
    const tab = await make({ workerUrl });
    expect(tab.features.has("superseded")).toBe(true);
    expect(tab.superseded).toBeUndefined();
  });

  it.each([
    {
      hosting: "a SharedWorker's server in a realm without BroadcastChannel",
      server: () => createServer(undefined, async () => new MemoryStore()),
    },
    {
      hosting: "a dedicated worker's server",
      server: () =>
        createServer(undefined, async () => new MemoryStore(), undefined, true),
    },
    {
      hosting: "a server built without an entry",
      server: () => new RpcServer(new Engine(), LIB_VERSION),
    },
  ])("$hosting does not list it", async ({ server }) => {
    // A BroadcastChannel in the realm changes nothing for the other hostings.
    fakeChannels().install();
    const { features, client } = await hello(server());
    expect(features).toEqual(["cacheChanged", "memoryBudget", "calendar-grid"]);
    expect(client.features.has("superseded")).toBe(false);
  });

  it("the in-process hosting does not list it, and a listener there is never called and prints nothing in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    fakeChannels().install();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const client = await make({ mode: "in-process" });
    expect([...client.features].sort()).toEqual([
      "cacheChanged",
      "calendar-grid",
      "memoryBudget",
    ]);
    const heard = vi.fn();
    const off = client.on("superseded", heard);
    // A round trip: anything the server had to say has arrived.
    await client.cache({ id: "c", interval: 1, fields: { v: "f64" } });
    off();
    expect(heard).not.toHaveBeenCalled();
    expect(client.superseded).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("a client keeps the names it knows of a hello that lists more", async () => {
    const server = new RpcServer(
      new Engine(),
      LIB_VERSION,
      undefined,
      undefined,
      {
        features: [
          "superseded",
          "from-a-later-release" as never,
          "cacheChanged",
        ],
      },
    );
    const { features, client } = await hello(server);
    expect(features).toEqual([
      "superseded",
      "from-a-later-release",
      "cacheChanged",
    ]);
    expect([...client.features].sort()).toEqual(["cacheChanged", "superseded"]);
  });
});
