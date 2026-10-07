import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "../src/engine/engine";
import {
  ConfigError,
  InvalidRangeError,
  ProtocolMismatchError,
  PutError,
  TscacheError,
  UnknownCacheError,
} from "../src/errors";
import { PortClient } from "../src/rpc/port-client";
import {
  type Evt,
  fromWireError,
  type Hello,
  type MessagePortLike,
  PROTOCOL_VERSION,
  toWireError,
  transferablesOf,
} from "../src/rpc/protocol";
import { RpcServer } from "../src/rpc/server";
import type { GetResult, PutBatch, Range } from "../src/types";

// Implementer tests (architecture §3, §4.7): the RPC layer over Node's
// MessageChannel, the same path in-process mode takes.

const config = {
  id: "rpc",
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

const open: { dispose(): void }[] = [];
afterEach(() => {
  for (const item of open.splice(0)) item.dispose();
});

async function connect(server: RpcServer): Promise<PortClient> {
  const channel = new MessageChannel();
  server.attach(channel.port1 as MessagePortLike);
  const client = await PortClient.connect(channel.port2 as MessagePortLike);
  open.push(client, {
    dispose: () => server.detach(channel.port1 as MessagePortLike),
  });
  return client;
}

function events(client: PortClient): Evt[] {
  const seen: Evt[] = [];
  client.on((evt) => seen.push(evt));
  return seen;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("handshake", () => {
  it("assigns clientIds in connection order and completes init", async () => {
    const server = new RpcServer(new Engine(), "0.0.0");
    const a = await connect(server);
    const b = await connect(server);
    expect(a.clientId).toBe("c1");
    expect(b.clientId).toBe("c2");
  });

  it("the client refuses a worker with another protocol", async () => {
    const channel = new MessageChannel();
    const hello: Hello = {
      t: "hello",
      protocol: PROTOCOL_VERSION + 1,
      lib: "9.9.9",
      clientId: "c1",
    };
    channel.port1.postMessage(hello);
    await expect(
      PortClient.connect(channel.port2 as MessagePortLike),
    ).rejects.toMatchObject({
      name: "ProtocolMismatchError",
      clientProtocol: PROTOCOL_VERSION,
      workerProtocol: PROTOCOL_VERSION + 1,
    });
    channel.port1.close();
  });

  it("the server refuses a client with another protocol and answers requests only after init", async () => {
    const server = new RpcServer(new Engine(), "0.0.0");
    const channel = new MessageChannel();
    const replies: unknown[] = [];
    channel.port2.addEventListener("message", (e) => replies.push(e.data));
    channel.port2.start();
    server.attach(channel.port1 as MessagePortLike);
    channel.port2.postMessage({ t: "req", id: 1, op: "clearAll", params: {} });
    channel.port2.postMessage({ t: "init", protocol: PROTOCOL_VERSION + 1 });
    await tick();
    await tick();
    expect(replies[0]).toMatchObject({ t: "hello", clientId: "c1" });
    expect(replies[1]).toMatchObject({
      t: "res",
      id: 1,
      ok: false,
      error: { name: "TscacheError", message: "not initialized" },
    });
    expect(replies[2]).toMatchObject({
      t: "init-err",
      error: { name: "ProtocolMismatchError" },
    });
    const error = fromWireError((replies[2] as { error: never }).error);
    expect(error).toBeInstanceOf(ProtocolMismatchError);
    expect(error).toMatchObject({
      clientProtocol: PROTOCOL_VERSION + 1,
      workerProtocol: PROTOCOL_VERSION,
    });
    channel.port2.close();
  });
});

describe("handshake order and failures", () => {
  it("rejects init-ok arriving before hello", async () => {
    const channel = new MessageChannel();
    channel.port1.postMessage({ t: "init-ok" });
    await expect(
      PortClient.connect(channel.port2 as MessagePortLike),
    ).rejects.toMatchObject({
      name: "TscacheError",
      message: expect.stringMatching(/out of order/),
    });
    channel.port1.close();
  });

  it("rejects when the fetcher context cannot be posted", async () => {
    const server = new RpcServer(new Engine(), "0.0.0");
    const channel = new MessageChannel();
    server.attach(channel.port1 as MessagePortLike);
    await expect(
      PortClient.connect(channel.port2 as MessagePortLike, {
        fetcher: { module: "x", context: { fn: () => 0 } },
      }),
    ).rejects.toThrow();
    server.detach(channel.port1 as MessagePortLike);
  });

  it("dispose is acknowledged before the port closes", async () => {
    const server = new RpcServer(new Engine(), "0.0.0");
    const channel = new MessageChannel();
    server.attach(channel.port1 as MessagePortLike);
    const client = await PortClient.connect(channel.port2 as MessagePortLike);
    await expect(client.request("dispose", {})).resolves.toBeUndefined();
    client.dispose();
  });
});

describe("operations round-trip", () => {
  it("drives every op through the wire with exact results", async () => {
    const engine = new Engine();
    const client = await connect(new RpcServer(engine, "0.0.0"));
    expect(await client.request("cache", config)).toEqual({
      ...config,
      gapSplitK: 4,
      segmentSlotCap: 32_768,
      warnOnOverlapDiff: false,
    });
    expect(
      await client.request("put", {
        cacheId: "rpc",
        batch: batch([3, 13, 23]),
        options: { range: { start: 3, end: 33 } },
      }),
    ).toEqual({ warnings: [] });
    expect(
      await client.request("get", {
        cacheId: "rpc",
        range: { start: 3, end: 43 },
      }),
    ).toEqual(
      result([3, 13, 23], [{ start: 3, end: 33 }], [{ start: 43, end: 43 }]),
    );
    await client.request("invalidate", {
      cacheId: "rpc",
      range: { start: 13, end: 13 },
    });
    await client.request("setFinalizedUntil", { cacheId: "rpc", t: 23 });
    expect(
      await client.request("get", {
        cacheId: "rpc",
        range: { start: 3, end: 43 },
      }),
    ).toEqual(
      result([3, 13, 23], [{ start: 3, end: 3 }], [{ start: 13, end: 43 }]),
    );
    expect(
      await client.request("updateAuth", { context: { token: "t" } }),
    ).toBeUndefined();
    await client.request("clear", { cacheId: "rpc" });
    await client.request("clearAll", {});
    expect(
      await client.request("get", {
        cacheId: "rpc",
        range: { start: 3, end: 3 },
      }),
    ).toEqual(result([], [], [{ start: 3, end: 3 }]));
    // The engine behind the wire holds the same state.
    expect(engine.has("rpc")).toBe(true);
  });

  it("rebuilds every error class with its fields on the client", async () => {
    const client = await connect(new RpcServer(new Engine(), "0.0.0"));
    await client.request("cache", config);
    await expect(
      client.request("put", { cacheId: "rpc", batch: batch([3, 14]) }),
    ).rejects.toMatchObject({
      name: "PutError",
      code: "misaligned",
      offenderIndex: 1,
      offenderTimestamp: 14,
      expected: expect.stringMatching(/3.*10/),
    });
    await expect(
      client.request("put", { cacheId: "rpc", batch: batch([3, 14]) }),
    ).rejects.toBeInstanceOf(PutError);
    await expect(
      client.request("get", {
        cacheId: "missing",
        range: { start: 0, end: 1 },
      }),
    ).rejects.toBeInstanceOf(UnknownCacheError);
    await expect(
      client.request("get", { cacheId: "rpc", range: { start: 1, end: 0 } }),
    ).rejects.toBeInstanceOf(InvalidRangeError);
    await expect(
      client.request("cache", { ...config, interval: 20 }),
    ).rejects.toBeInstanceOf(ConfigError);
    for (const op of ["nonsense", "toString", "constructor", "__proto__"]) {
      await expect(client.request(op as never, {})).rejects.toMatchObject({
        name: "TscacheError",
        message: expect.stringMatching(/unknown op/),
      });
    }
    // Malformed params never crash the server: they come back as errors.
    await expect(client.request("get", null)).rejects.toBeInstanceOf(
      TscacheError,
    );
    await expect(
      client.request("get", { cacheId: "rpc" }),
    ).rejects.toBeInstanceOf(InvalidRangeError);
  });
});

describe("events", () => {
  it("fans cacheCleared out to every ready port and mergeWarning with the caller's requestId", async () => {
    const server = new RpcServer(new Engine(), "0.0.0");
    const a = await connect(server);
    const b = await connect(server);
    const seenA = events(a);
    const seenB = events(b);
    await a.request("cache", { ...config, warnOnOverlapDiff: true });
    await a.request("put", { cacheId: "rpc", batch: batch([3, 13]) });
    await b.request("put", {
      cacheId: "rpc",
      batch: batch([3, 13], [30, 130]),
    });
    await a.request("clear", { cacheId: "rpc" });
    await tick();
    const warning = {
      t: "evt",
      scope: "request",
      cacheId: "rpc",
      requestId: "c2:1",
      event: "mergeWarning",
      payload: {
        cacheId: "rpc",
        requestId: "c2:1",
        range: { start: 3, end: 13 },
        fields: ["price"],
      },
    };
    const cleared = {
      t: "evt",
      scope: "cache",
      cacheId: "rpc",
      event: "cacheCleared",
      payload: { cacheId: "rpc", reason: "manual" },
    };
    expect(seenA).toEqual([warning, cleared]);
    expect(seenB).toEqual([warning, cleared]);
  });

  it("a detached or disposed port receives nothing more and its requests reject", async () => {
    const server = new RpcServer(new Engine(), "0.0.0");
    const a = await connect(server);
    const b = await connect(server);
    const seenB = events(b);
    await a.request("cache", config);
    const pending = b.request("get", {
      cacheId: "rpc",
      range: { start: 3, end: 3 },
    });
    b.dispose();
    b.dispose();
    await expect(pending).rejects.toBeInstanceOf(TscacheError);
    await expect(b.request("clearAll", {})).rejects.toBeInstanceOf(
      TscacheError,
    );
    await a.request("clear", { cacheId: "rpc" });
    await tick();
    expect(seenB).toEqual([]);
  });
});

describe("transport closure", () => {
  it("a server-side detach rejects pending and later requests on the client", async () => {
    const server = new RpcServer(new Engine(), "0.0.0");
    const channel = new MessageChannel();
    server.attach(channel.port1 as MessagePortLike);
    const client = await PortClient.connect(channel.port2 as MessagePortLike);
    await client.request("cache", config);
    const pending = client.request("clearAll", {});
    server.detach(channel.port1 as MessagePortLike);
    await expect(pending).rejects.toMatchObject({
      name: "TscacheError",
      message: "port closed",
    });
    await expect(client.request("clearAll", {})).rejects.toBeInstanceOf(
      TscacheError,
    );
    client.dispose();
  });
});

describe("transfer", () => {
  it("get results arrive as fresh arrays and put transfers the caller's buffers", async () => {
    const client = await connect(new RpcServer(new Engine(), "0.0.0"));
    await client.request("cache", config);
    const input = batch([3, 13]);
    const prices = input.fields.price as Float64Array;
    expect(prices.byteLength).toBe(16);
    await client.request(
      "put",
      { cacheId: "rpc", batch: input },
      transferablesOf(input),
    );
    // Transferred buffers are detached on the sending side (§3.3).
    expect(prices.byteLength).toBe(0);
    const got = (await client.request("get", {
      cacheId: "rpc",
      range: { start: 3, end: 13 },
    })) as GetResult;
    expect(got.fields.price).toEqual(new Float64Array([3, 13]));
    got.timestamps.fill(0);
    expect(
      await client.request("get", {
        cacheId: "rpc",
        range: { start: 3, end: 13 },
      }),
    ).toEqual(result([3, 13], [{ start: 3, end: 13 }], []));
  });

  it("transferablesOf lists each buffer once and skips plain arrays", () => {
    const shared = new ArrayBuffer(32);
    const value = {
      timestamps: new Float64Array(shared, 0, 2),
      fields: { a: new Float64Array(shared, 16, 2), b: [1, 2] },
    };
    expect(transferablesOf(value)).toEqual([shared]);
    expect(transferablesOf({})).toEqual([]);
  });
});

describe("wire errors", () => {
  it("names a §2.6 error by its class even when a minifier renamed the constructor", () => {
    const error = new PutError("bad", { code: "duplicate", offenderIndex: 2 });
    Object.defineProperty(error, "name", { value: "t" });
    expect(toWireError(error)).toMatchObject({
      name: "PutError",
      code: "duplicate",
    });
    const rebuilt = fromWireError(toWireError(error));
    expect(rebuilt).toBeInstanceOf(PutError);
    expect(rebuilt).toMatchObject({ code: "duplicate", offenderIndex: 2 });
    class Odd extends Error {}
    expect(toWireError(new Odd("x")).name).toBe("Error");
  });

  it("round-trips a non-Error throw and an unknown class name", () => {
    expect(toWireError("boom")).toEqual({ name: "Error", message: "boom" });
    const rebuilt = fromWireError({ name: "SomethingElse", message: "x" });
    expect(rebuilt).toBeInstanceOf(TscacheError);
    expect(rebuilt.message).toBe("SomethingElse: x");
  });
});
