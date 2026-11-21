import { afterEach, describe, expect, it, vi } from "vitest";
import { PortClient } from "../src/rpc/port-client";
import { LIB_VERSION, type MessagePortLike } from "../src/rpc/protocol";
import { fakeChannels } from "./workers-channel";

// Implementer tests: entries/worker.ts as each worker global runs it, among
// the workers of its origin (architecture §4.7, Generations; §4.10.8,
// Entries; N108). The entry is loaded with the worker globals stubbed, as
// hosting.test.ts loads it.

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  vi.unstubAllGlobals();
});

const fetcherModule = `data:text/javascript,${encodeURIComponent(
  "export default { async fetch() { return { timestamps: [], fields: {} }; } };",
)}`;

/** Loads the entry as a SharedWorker global of `name` at `href` runs it. */
async function sharedWorker(href: string, name: string) {
  const connect: ((event: { ports: MessagePortLike[] }) => void)[] = [];
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("importScripts", () => {});
  vi.stubGlobal("onconnect", null);
  vi.stubGlobal("location", { href });
  vi.stubGlobal("name", name);
  vi.stubGlobal(
    "addEventListener",
    (type: string, fn: (event: { ports: MessagePortLike[] }) => void) => {
      if (type === "connect") connect.push(fn);
    },
  );
  vi.resetModules();
  await import("../src/entries/worker");
  return async (module?: string) => {
    const channel = new MessageChannel();
    cleanup.push(() => {
      channel.port1.close();
      channel.port2.close();
    });
    connect[0]?.({ ports: [channel.port1 as MessagePortLike] });
    const client = await PortClient.connect(
      channel.port2 as MessagePortLike,
      module === undefined ? {} : { fetcher: { module } },
    );
    cleanup.push(() => client.dispose());
    return client;
  };
}

describe("the SharedWorker entry among the workers of its origin", () => {
  it("opens the channel before its first connection and announces what it runs after the first init", async () => {
    const bus = fakeChannels();
    bus.install();
    const href = "https://app.example/assets/worker-abc.js";
    const name = `tscache:${LIB_VERSION}:${fetcherModule}`;
    const tab = await sharedWorker(href, name);
    // The lifetime lock settles first (none here): then the channel is open.
    await vi.waitFor(() => expect(bus.counts.opened).toBe(1), {
      timeout: 4000,
      interval: 1,
    });
    expect(bus.posts).toEqual([]);

    await tab(fetcherModule);
    await tab(fetcherModule);
    expect(bus.posts).toHaveLength(1);
    expect(bus.posts[0]).toEqual({
      t: "announce",
      v: 1,
      id: expect.stringMatching(/^[0-9a-f]{32}$/),
      lib: LIB_VERSION,
      url: href,
      fetcher: fetcherModule,
      name,
      startedAt: performance.timeOrigin,
    });
  });

  it("without BroadcastChannel it serves as before and announces nothing", async () => {
    const tab = await sharedWorker("https://app.example/worker.js", "");
    const client = await tab();
    await expect(
      client.request("cache", { id: "c", interval: 1, fields: { v: "f64" } }),
    ).resolves.toMatchObject({ id: "c" });
  });
});
