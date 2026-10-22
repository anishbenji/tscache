import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "../src/client/client";
import { Engine } from "../src/engine/engine";
import { TscacheError } from "../src/errors";
import { PortClient } from "../src/rpc/port-client";
import {
  type MessagePortLike,
  type Op,
  transferablesOf,
} from "../src/rpc/protocol";
import { RpcServer } from "../src/rpc/server";
import { decodeSnapshot, encodeSnapshot } from "../src/snapshot";
import type {
  GetResult,
  HydrateResult,
  PutBatch,
  Snapshot,
} from "../src/types";

// Implementer tests (architecture §2.8, §3.2–§3.3, §4.7–§4.9): the snapshot
// API across the RPC layer, the orchestrator and the client handle.

const config = {
  id: "wiring",
  interval: 10,
  alignmentOffset: 3,
  fields: { price: "f64", volume: "i16" },
} as const;

function batch(timestamps: number[]): PutBatch {
  return {
    timestamps: new Float64Array(timestamps),
    fields: {
      price: new Float64Array(timestamps),
      volume: new Int16Array(timestamps),
    },
  };
}

const open: { dispose(): unknown }[] = [];
afterEach(async () => {
  for (const item of open.splice(0)) await item.dispose();
});

async function connect(
  server: RpcServer,
  fetcher?: { module: string },
): Promise<PortClient> {
  const channel = new MessageChannel();
  server.attach(channel.port1 as MessagePortLike);
  const client = await PortClient.connect(
    channel.port2 as MessagePortLike,
    fetcher === undefined ? undefined : { fetcher },
  );
  open.push(client);
  return client;
}

/** A fetcher answering every aligned slot of the range with price = t. */
const fetcherModule = `data:text/javascript,${encodeURIComponent(`
  export default {
    async fetch(req) {
      const ts = [];
      const first = Math.ceil((req.range.start - req.alignmentOffset) / req.interval) * req.interval + req.alignmentOffset;
      for (let t = first; t <= req.range.end; t += req.interval) ts.push(t);
      return { timestamps: ts, fields: { price: ts, volume: ts }, meta: { version: "v1" } };
    },
  };
`)}`;

describe("hydrate over the wire (§3.2, §4.7)", () => {
  it("round-trips a snapshot taken in one engine into another", async () => {
    const source = new Engine();
    source.cache(config);
    source.put("wiring", batch([3, 13, 33]));
    const snapshot = source.snapshot("wiring", { start: 3, end: 43 });

    const client = await connect(new RpcServer(new Engine(), "0.0.0"));
    await client.request("cache", config);
    const outcome = (await client.request("hydrate", {
      cacheId: "wiring",
      snapshot,
    })) as HydrateResult;
    expect(outcome).toEqual({ applied: [{ start: 3, end: 33 }] });
    const read = (await client.request("get", {
      cacheId: "wiring",
      range: { start: 3, end: 43 },
    })) as GetResult;
    expect([...read.timestamps]).toEqual([3, 13, 33]);
    expect(read.coverage).toEqual([{ start: 3, end: 33 }]);
    // Cloned, not transferred: the caller's snapshot is intact (§2.8).
    expect(snapshot).toEqual(source.snapshot("wiring", { start: 3, end: 43 }));
  });

  it("rejects an invalid snapshot with the engine's TscacheError", async () => {
    const client = await connect(new RpcServer(new Engine(), "0.0.0"));
    await client.request("cache", config);
    const bad = { format: 2 } as unknown as Snapshot;
    await expect(
      client.request("hydrate", { cacheId: "wiring", snapshot: bad }),
    ).rejects.toThrow(/^invalid snapshot:/);
  });

  it("transferablesOf lists a snapshot's mask and field buffers once each", () => {
    const engine = new Engine();
    engine.cache(config);
    engine.put("wiring", batch([3, 13]));
    const read = engine.get(
      "wiring",
      { start: 3, end: 13 },
      { snapshot: true },
    );
    const payload = read.snapshot?.segments[0];
    if (payload === undefined) throw new Error("no payload");
    const buffers = transferablesOf(read);
    expect(buffers).toContain(payload.mask.buffer);
    for (const { data } of payload.fields) expect(buffers).toContain(data);
    expect(new Set(buffers).size).toBe(buffers.length);
  });

  it("an op the server lacks rejects with TscacheError, as hydrate does against an older worker (N37)", async () => {
    const client = await connect(new RpcServer(new Engine(), "0.0.0"));
    await expect(
      client.request("not-an-op" as Op, { cacheId: "wiring" }),
    ).rejects.toThrow(TscacheError);
    await expect(
      client.request("not-an-op" as Op, { cacheId: "wiring" }),
    ).rejects.toThrow(/unknown op/);
  });
});

describe("orchestrated get with a snapshot (§4.9, N36)", () => {
  it("takes the snapshot from the read after the fetch, with the fetched version", async () => {
    const client = await connect(new RpcServer(new Engine(), "0.0.0"), {
      module: fetcherModule,
    });
    await client.request("cache", config);
    const read = (await client.request("get", {
      cacheId: "wiring",
      range: { start: 3, end: 23 },
      options: { snapshot: true },
    })) as GetResult;
    expect([...read.timestamps]).toEqual([3, 13, 23]);
    expect(read.snapshot?.coverage).toEqual(read.coverage);
    expect(read.snapshot?.coverage).toEqual([{ start: 3, end: 23 }]);
    expect(read.snapshot?.version).toBe("v1");
    expect(read.snapshot?.segments).toHaveLength(1);
  });

  it("cacheOnly with a snapshot reads without fetching", async () => {
    const client = await connect(new RpcServer(new Engine(), "0.0.0"), {
      module: fetcherModule,
    });
    await client.request("cache", config);
    const read = (await client.request("get", {
      cacheId: "wiring",
      range: { start: 3, end: 23 },
      options: { cacheOnly: true, snapshot: true },
    })) as GetResult;
    expect(read.timestamps.length).toBe(0);
    expect(read.snapshot).toMatchObject({ coverage: [], segments: [] });
  });
});

describe("CacheHandle.hydrate in process (§4.8)", () => {
  it("seeds a client from an encoded snapshot and keeps the snapshot usable", async () => {
    const server = await createClient({ mode: "in-process" });
    open.push(server);
    const serverCache = await server.cache(config);
    await serverCache.put(batch([3, 13, 23]), { range: { start: 3, end: 33 } });
    const { snapshot } = await serverCache.get(
      { start: 3, end: 33 },
      { snapshot: true },
    );
    if (snapshot === undefined) throw new Error("no snapshot");
    const page = JSON.parse(JSON.stringify(encodeSnapshot(snapshot)));
    const seed = decodeSnapshot(page);

    for (let i = 0; i < 2; i++) {
      const browser = await createClient({ mode: "in-process" });
      open.push(browser);
      const cache = await browser.cache(config);
      expect(await cache.hydrate(seed)).toEqual({
        applied: [{ start: 3, end: 33 }],
      });
      const read = await cache.get({ start: 3, end: 33 }, { cacheOnly: true });
      expect([...read.timestamps]).toEqual([3, 13, 23]);
      expect(read.coverage).toEqual([{ start: 3, end: 33 }]);
    }
  });
});
