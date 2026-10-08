import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "../src/client/client";
import { Engine } from "../src/engine/engine";
import { TscacheError } from "../src/errors";
import { coalesce } from "../src/orchestrator/orchestrator";
import { PortClient } from "../src/rpc/port-client";
import type { Evt, MessagePortLike } from "../src/rpc/protocol";
import { RpcServer } from "../src/rpc/server";
import type { FetchRequest, GetResult, Range } from "../src/types";

// Implementer tests (architecture §2.5, §4.9): orchestration through the
// real RPC path with fetcher modules served as data: URLs.

const config = {
  id: "o",
  interval: 10,
  alignmentOffset: 3,
  fields: { price: "f64", volume: "i16" },
} as const;

/** The fetchers record what they were asked on this global. */
interface Log {
  requests: FetchRequest[];
  auth: unknown[];
  mode: "ok" | "fail" | "auth" | "slow";
  release?: () => void;
}
const log = (): Log => (globalThis as unknown as { __tsc: Log }).__tsc;
function resetLog(mode: Log["mode"] = "ok"): void {
  (globalThis as unknown as { __tsc: Log }).__tsc = {
    requests: [],
    auth: [],
    mode,
  };
}

/** A fetcher module: answers every aligned slot of the range with price = t, volume = call count. */
const fetcherSource = `
  // Read per call: the module instance is cached across tests.
  const log = () => globalThis.__tsc;
  export default {
    async fetch(req) {
      const g = log();
      g.requests.push(req);
      if (g.mode === "fail") throw new Error("backend down");
      if (g.mode === "auth") { const e = new Error("401"); e.code = "tscache:auth-invalid"; throw e; }
      if (g.mode === "slow") await new Promise((r) => { g.release = r; });
      const ts = [];
      for (let t = Math.ceil((req.range.start - req.alignmentOffset) / req.interval) * req.interval + req.alignmentOffset; t <= req.range.end; t += req.interval) ts.push(t);
      const n = g.requests.length;
      const meta = req.context && req.context.version ? { version: req.context.version } : undefined;
      return { timestamps: ts, fields: { price: ts, volume: ts.map(() => n) }, ...(meta ? { meta } : {}) };
    },
    updateAuth(context) { log().auth.push(context); },
  };
`;
const dataUrl = (source: string) =>
  `data:text/javascript,${encodeURIComponent(source)}`;
const fetcherModule = dataUrl(fetcherSource);

function result(
  timestamps: number[],
  coverage: Range[],
  misses: GetResult["misses"],
  volumes: number[],
): GetResult {
  return {
    timestamps: new Float64Array(timestamps),
    fields: {
      price: new Float64Array(timestamps),
      volume: new Int16Array(volumes),
    },
    coverage,
    misses,
  };
}

const open: { dispose(): unknown }[] = [];
afterEach(async () => {
  for (const item of open.splice(0)) await item.dispose();
});

/** Two clients on one server, as two tabs share a SharedWorker. */
async function pair(context?: unknown) {
  const server = new RpcServer(new Engine(), "0.0.0");
  const connect = async () => {
    const channel = new MessageChannel();
    server.attach(channel.port1 as MessagePortLike);
    const client = await PortClient.connect(channel.port2 as MessagePortLike, {
      fetcher: {
        module: fetcherModule,
        ...(context !== undefined ? { context } : {}),
      },
    });
    open.push(client);
    return client;
  };
  const a = await connect();
  const b = await connect();
  await a.request("cache", config);
  return { a, b, server };
}

const get = (c: PortClient, range: Range, options?: unknown) =>
  c.request("get", { cacheId: "o", range, options }) as Promise<GetResult>;

describe("coalesce", () => {
  it("merges adjacent misses and extends into abutting coverage by one interval", () => {
    expect(
      coalesce([{ start: 43, end: 63 }], [{ start: 3, end: 33 }], 10),
    ).toEqual([{ start: 33, end: 63 }]);
    expect(
      coalesce(
        [
          { start: 3, end: 13 },
          { start: 33, end: 43 },
        ],
        [{ start: 23, end: 23 }],
        10,
      ),
    ).toEqual([{ start: 3, end: 43 }]);
    expect(coalesce([], [], 10)).toEqual([]);
  });
});

describe("fetcher loading (N30)", () => {
  it("a module that fails to import or lacks fetch() rejects createClient", async () => {
    await expect(
      createClient({
        mode: "in-process",
        fetcher: { module: dataUrl('throw new Error("boom")') },
      }),
    ).rejects.toMatchObject({
      name: "TscacheError",
      message: expect.stringMatching(/failed to load.*boom/s),
    });
    await expect(
      createClient({
        mode: "in-process",
        fetcher: { module: dataUrl("export default {}") },
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/must default-export/),
    });
  });
});

describe("orchestrated get", () => {
  it("fetches the coalesced misses once, applies them as authoritative, and reports nothing missing", async () => {
    resetLog();
    const { a } = await pair({ token: "t1" });
    expect(await get(a, { start: 3, end: 33 })).toEqual(
      result([3, 13, 23, 33], [{ start: 3, end: 33 }], [], [1, 1, 1, 1]),
    );
    expect(log().requests).toEqual([
      {
        cacheId: "o",
        range: { start: 3, end: 33 },
        interval: 10,
        alignmentOffset: 3,
        context: { token: "t1" },
      },
    ]);
    // Covered now: no second fetch, and the flank into coverage is one interval.
    await get(a, { start: 3, end: 33 });
    expect(log().requests).toHaveLength(1);
    await get(a, { start: 43, end: 63 });
    expect(log().requests[1]?.range).toEqual({ start: 33, end: 63 });
  });

  it("cacheOnly skips fetching; without a fetcher get is cache-only", async () => {
    resetLog();
    const { a } = await pair();
    expect(await get(a, { start: 3, end: 13 }, { cacheOnly: true })).toEqual(
      result(
        [],
        [],
        [{ range: { start: 3, end: 13 }, reason: "uncached" }],
        [],
      ),
    );
    expect(log().requests).toEqual([]);
    const plain = await createClient({ mode: "in-process" });
    open.push(plain);
    const cache = await plain.cache(config);
    expect((await cache.get({ start: 3, end: 13 })).misses[0]?.reason).toBe(
      "uncached",
    );
  });

  it("deduplicates identical in-flight ranges across clients (N31)", async () => {
    resetLog("slow");
    const { a, b } = await pair();
    const pa = get(a, { start: 3, end: 23 });
    await new Promise((r) => setTimeout(r, 20));
    const pb = get(b, { start: 3, end: 23 });
    await new Promise((r) => setTimeout(r, 20));
    expect(log().requests).toHaveLength(1);
    log().release?.();
    const [ra, rb] = await Promise.all([pa, pb]);
    expect(ra).toEqual(rb);
    expect(Array.from(ra.fields.volume as Int16Array)).toEqual([1, 1, 1]);
  });

  it("a fetch that throws yields fetch-failed for that get only", async () => {
    resetLog("fail");
    const { a } = await pair();
    expect((await get(a, { start: 3, end: 13 })).misses).toEqual([
      {
        range: { start: 3, end: 13 },
        reason: "fetch-failed",
        error: { name: "Error", message: "backend down" },
      },
    ]);
    log().mode = "ok";
    expect((await get(a, { start: 3, end: 13 })).misses).toEqual([]);
    expect(log().requests).toHaveLength(2);
  });
});

describe("auth (designs b and y)", () => {
  it("broadcasts authInvalid once, answers auth-pending without fetching, and resumes after updateAuth", async () => {
    resetLog("auth");
    const { a, b } = await pair({ token: "old" });
    const seenA: Evt[] = [];
    const seenB: Evt[] = [];
    a.on((e) => seenA.push(e));
    b.on((e) => seenB.push(e));
    const first = await get(a, { start: 3, end: 13 });
    expect(first.misses).toEqual([
      { range: { start: 3, end: 13 }, reason: "auth-pending" },
    ]);
    // While invalid, nothing is fetched and every miss is auth-pending.
    const second = await get(b, { start: 23, end: 33 });
    expect(second.misses[0]?.reason).toBe("auth-pending");
    expect(log().requests).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 10));
    const authEvents = (seen: Evt[]) =>
      seen.filter((e) => e.scope === "client" && e.event === "authInvalid");
    expect(authEvents(seenA)).toHaveLength(1);
    expect(authEvents(seenB)).toHaveLength(1);
    expect(authEvents(seenA)[0]).toMatchObject({
      payload: { error: { name: "Error", message: "401" } },
    });
    // New material from any tab: the fetcher hears it and fetches resume.
    log().mode = "ok";
    await b.request("updateAuth", { context: { token: "new" } });
    expect(log().auth).toEqual([{ token: "new" }]);
    const third = await get(a, { start: 3, end: 13 });
    expect(third.misses).toEqual([]);
    expect(log().requests.at(-1)?.context).toEqual({ token: "new" });
  });
});

describe("version fence (N29)", () => {
  it("drops a response from before a version clear, refetches once, then reports uncached", async () => {
    resetLog("slow");
    const { a } = await pair();
    // A versioned cache: a later, different version clears it (N18).
    await a.request("put", {
      cacheId: "o",
      batch: {
        timestamps: [],
        fields: { price: [], volume: [] },
        meta: { version: "v1" },
      },
    });
    const pending = get(a, { start: 3, end: 13 });
    await new Promise((r) => setTimeout(r, 20));
    // A newer version arrives while the fetch is in flight.
    await a.request("put", {
      cacheId: "o",
      batch: {
        timestamps: [],
        fields: { price: [], volume: [] },
        meta: { version: "v2" },
      },
    });
    log().mode = "ok";
    log().release?.();
    const got = await pending;
    // The stale answer was dropped and the range fetched again.
    expect(log().requests).toHaveLength(2);
    expect(got.misses).toEqual([]);
    expect(Array.from(got.fields.volume as Int16Array)).toEqual([2, 2]);
  });

  it("a response carrying a newer version clears the cache inside its own put and is not fenced", async () => {
    resetLog();
    const { a } = await pair({ version: "v9" });
    await a.request("put", {
      cacheId: "o",
      batch: {
        timestamps: [43],
        fields: { price: [43], volume: [0] },
        meta: { version: "v1" },
      },
    });
    const got = await get(a, { start: 3, end: 13 });
    expect(got.misses).toEqual([]);
    expect(Array.from(got.timestamps)).toEqual([3, 13]);
    // The old data under v1 is gone.
    expect(
      Array.from(
        (await get(a, { start: 43, end: 43 }, { cacheOnly: true })).timestamps,
      ),
    ).toEqual([]);
  });
});

describe("the ./fetcher entry", () => {
  it("exports the marker and the error class and nothing DOM-bound", async () => {
    const entry = await import("../src/entries/fetcher");
    expect(entry.AUTH_INVALID_CODE).toBe("tscache:auth-invalid");
    const error = new entry.AuthInvalidError("x");
    expect(error).toBeInstanceOf(TscacheError);
    expect(error.code).toBe("tscache:auth-invalid");
  });
});
