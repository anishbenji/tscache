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
  mode: "ok" | "fail" | "auth" | "slow" | "bad";
  /** What a stalled fetch does once released. */
  afterRelease?: "auth" | "fail";
  release?: () => void;
  /** updateAuth stalls until releaseAuth is called. */
  slowAuth?: boolean;
  releaseAuth?: () => void;
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
      if (g.mode === "bad") return { timestamps: [req.range.start + 1], fields: { price: [1], volume: [1] } };
      if (g.mode === "auth") { const e = new Error("401"); e.code = "tscache:auth-invalid"; throw e; }
      if (g.mode === "slow") {
        await new Promise((r) => { g.release = r; });
        if (g.afterRelease === "auth") { const e = new Error("401 late"); e.code = "tscache:auth-invalid"; throw e; }
        if (g.afterRelease === "fail") throw new Error("late failure");
      }
      const ts = [];
      for (let t = Math.ceil((req.range.start - req.alignmentOffset) / req.interval) * req.interval + req.alignmentOffset; t <= req.range.end; t += req.interval) ts.push(t);
      const n = g.requests.length;
      const meta = req.context && req.context.version ? { version: req.context.version } : undefined;
      return { timestamps: ts, fields: { price: ts, volume: ts.map(() => n) }, ...(meta ? { meta } : {}) };
    },
    async updateAuth(context) {
      const g = log();
      if (g.slowAuth) await new Promise((r) => { g.releaseAuth = r; });
      g.auth.push(context);
    },
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

/** Collects every stalled fetch's release function in order. */
function captureReleases(): (() => void)[] {
  const releases: (() => void)[] = [];
  const original = log();
  (globalThis as unknown as { __tsc: Log }).__tsc = new Proxy(original, {
    set(target, key, value) {
      if (key === "release") releases.push(value as () => void);
      else Reflect.set(target, key, value);
      return true;
    },
  });
  return releases;
}

/** Collects every stalled updateAuth's release function in order. */
function captureAuthReleases(): (() => void)[] {
  const releases: (() => void)[] = [];
  const current = (globalThis as unknown as { __tsc: Log }).__tsc;
  current.slowAuth = true;
  (globalThis as unknown as { __tsc: Log }).__tsc = new Proxy(current, {
    set(target, key, value) {
      if (key === "releaseAuth") releases.push(value as () => void);
      else Reflect.set(target, key, value);
      return true;
    },
  });
  return releases;
}

const get = (c: PortClient, range: Range, options?: unknown) =>
  c.request("get", { cacheId: "o", range, options }) as Promise<GetResult>;

describe("coalesce (slots)", () => {
  const grid = { interval: 10, alignmentOffset: 3 };
  it("merges adjacent misses and extends one slot into abutting coverage", () => {
    expect(
      coalesce([{ start: 4, end: 6 }], [{ start: 0, end: 3 }], grid),
    ).toEqual([{ start: 3, end: 6 }]);
    expect(
      coalesce(
        [
          { start: 0, end: 1 },
          { start: 3, end: 4 },
        ],
        [{ start: 2, end: 2 }],
        grid,
      ),
    ).toEqual([{ start: 0, end: 4 }]);
    expect(coalesce([], [], grid)).toEqual([]);
  });

  it("never extends beyond a safe grid point", () => {
    const unit = { interval: 1, alignmentOffset: 0 };
    const top = Number.MAX_SAFE_INTEGER;
    expect(
      coalesce(
        [{ start: top, end: top }],
        [{ start: top + 1, end: top + 1 }],
        unit,
      ),
    ).toEqual([{ start: top, end: top }]);
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
    // The second tab's join already delivered {old} once: a cloned context is
    // not the identical value, so it counts as new material.
    expect(log().auth).toEqual([{ token: "old" }, { token: "new" }]);
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

describe("round 1 regressions", () => {
  it("concurrent inits with different modules: the first wins, the other is a ConfigError; the same module shares one load", async () => {
    resetLog();
    const server = new RpcServer(new Engine(), "0.0.0");
    const connect = (module: string) => {
      const channel = new MessageChannel();
      server.attach(channel.port1 as MessagePortLike);
      return PortClient.connect(channel.port2 as MessagePortLike, {
        fetcher: { module },
      });
    };
    const other = dataUrl(
      `export default { async fetch() { return { timestamps: [], fields: { price: [], volume: [] } }; } };`,
    );
    const [first, second, third] = await Promise.allSettled([
      connect(fetcherModule),
      connect(other),
      connect(fetcherModule),
    ]);
    expect(first.status).toBe("fulfilled");
    expect(third.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    expect((second as PromiseRejectedResult).reason).toMatchObject({
      name: "ConfigError",
      message: expect.stringMatching(/already runs fetcher/),
    });
    for (const r of [first, third]) {
      if (r.status === "fulfilled") open.push(r.value);
    }
  });

  it("the fence retry covers a dropped range even when an earlier fetch of the same get applied", async () => {
    resetLog();
    const { a } = await pair();
    await a.request("put", {
      cacheId: "o",
      batch: {
        timestamps: [23, 33, 43, 53],
        fields: { price: [23, 33, 43, 53], volume: [0, 0, 0, 0] },
        meta: { version: "v1" },
      },
      options: { range: { start: 23, end: 53 } },
    });
    // Two misses: [3,13] and [63,73]; the fetcher stalls on every call, so
    // both fetches are in flight when the version changes.
    log().mode = "slow";
    const releases = captureReleases();
    const pending = get(a, { start: 3, end: 73 });
    await new Promise((r) => setTimeout(r, 30));
    expect(releases).toHaveLength(2);
    // First fetch applies, then a newer version clears, then the second
    // fetch answers and must be dropped and re-requested.
    releases[0]?.();
    await new Promise((r) => setTimeout(r, 10));
    await a.request("put", {
      cacheId: "o",
      batch: {
        timestamps: [],
        fields: { price: [], volume: [] },
        meta: { version: "v2" },
      },
    });
    log().mode = "ok";
    releases[1]?.();
    const got = await pending;
    expect(got.misses).toEqual([]);
    expect(log().requests.length).toBeGreaterThanOrEqual(3);
  });

  it("a covered single-slot read at the safe-integer boundary does not throw with a fetcher loaded", async () => {
    resetLog();
    const server = new RpcServer(new Engine(), "0.0.0");
    const channel = new MessageChannel();
    server.attach(channel.port1 as MessagePortLike);
    const client = await PortClient.connect(channel.port2 as MessagePortLike, {
      fetcher: { module: fetcherModule },
    });
    open.push(client);
    const unit = {
      id: "edge",
      interval: 1,
      fields: { price: "f64", volume: "i16" },
    };
    await client.request("cache", unit);
    const t = Number.MAX_SAFE_INTEGER;
    await client.request("put", {
      cacheId: "edge",
      batch: { timestamps: [t], fields: { price: [1], volume: [1] } },
    });
    const got = (await client.request("get", {
      cacheId: "edge",
      range: { start: t, end: t },
    })) as GetResult;
    expect(Array.from(got.timestamps)).toEqual([t]);
    expect(got.misses).toEqual([]);
    expect(log().requests).toEqual([]);
  });

  it("warnings from an orchestrated fetch reach subscribers once, under the get's requestId", async () => {
    resetLog();
    const { a, b } = await pair();
    await a.request("cache", { ...config, id: "w", warnOnOverlapDiff: true });
    await a.request("put", {
      cacheId: "w",
      batch: { timestamps: [3], fields: { price: [999], volume: [0] } },
    });
    const seenA: Evt[] = [];
    const seenB: Evt[] = [];
    a.on((e) => seenA.push(e));
    b.on((e) => seenB.push(e));
    // The fetch extends into the covered slot 3 and returns price 3 there.
    await a.request("get", { cacheId: "w", range: { start: 13, end: 13 } });
    await new Promise((r) => setTimeout(r, 10));
    const warnings = (seen: Evt[]) =>
      seen.filter((e) => e.event === "mergeWarning");
    expect(warnings(seenA)).toEqual([
      expect.objectContaining({
        scope: "request",
        cacheId: "w",
        requestId: expect.stringMatching(/^c1:\d+$/),
        payload: expect.objectContaining({
          range: { start: 3, end: 3 },
          fields: ["price", "volume"],
        }),
      }),
    ]);
    expect(warnings(seenB)).toHaveLength(1);
  });

  it("an auth failure under superseded credentials does not invalidate the new ones", async () => {
    resetLog("slow");
    const { a } = await pair({ token: "old" });
    const releases = captureReleases();
    const first = get(a, { start: 3, end: 13 });
    const second = get(a, { start: 43, end: 53 });
    await new Promise((r) => setTimeout(r, 30));
    expect(releases).toHaveLength(2);
    // The first stalled fetch fails with 401: auth goes invalid.
    log().afterRelease = "auth";
    releases[0]?.();
    expect((await first).misses[0]?.reason).toBe("auth-pending");
    // New credentials arrive while the second old-token fetch is still out.
    await a.request("updateAuth", { context: { token: "new" } });
    releases[1]?.();
    expect((await second).misses[0]?.reason).toBe("auth-pending");
    // Its late 401 must not have invalidated the new credentials.
    log().mode = "ok";
    const third = await get(a, { start: 63, end: 73 });
    expect(third.misses).toEqual([]);
    expect(log().requests.at(-1)?.context).toEqual({ token: "new" });
  });
});

describe("round 2 regressions", () => {
  it("an aligned single-slot read near the safe boundary on an offset grid probes safely", async () => {
    resetLog();
    const { a } = await pair();
    const t = Number.MAX_SAFE_INTEGER - 8; // ≡ 3 (mod 10)
    const got = await get(a, { start: t, end: t });
    expect(got.misses).toEqual([]);
    expect(Array.from(got.timestamps)).toEqual([t]);
    expect(log().requests).toHaveLength(1);
  });

  it("after a failed fetch and a fenced one, the retry asks for aligned ranges and labels each piece", async () => {
    resetLog("slow");
    const { a } = await pair();
    await a.request("put", {
      cacheId: "o",
      batch: {
        timestamps: [23, 33, 43, 53],
        fields: { price: [23, 33, 43, 53], volume: [0, 0, 0, 0] },
        meta: { version: "v1" },
      },
      options: { range: { start: 23, end: 53 } },
    });
    const releases = captureReleases();
    const pending = get(a, { start: 3, end: 73 });
    await new Promise((r) => setTimeout(r, 30));
    expect(releases).toHaveLength(2);
    // Left fetch [3,23] fails; a version clear fences the right one [53,73].
    log().afterRelease = "fail";
    releases[0]?.();
    await new Promise((r) => setTimeout(r, 10));
    delete log().afterRelease;
    await a.request("put", {
      cacheId: "o",
      batch: {
        timestamps: [],
        fields: { price: [], volume: [] },
        meta: { version: "v2" },
      },
    });
    releases[1]?.();
    await new Promise((r) => setTimeout(r, 10));
    // The retry covers what is still uncached minus the failed range, on grid.
    const retry = log().requests[2];
    expect(retry?.range).toEqual({ start: 33, end: 73 });
    // Fence the retry too: the get then reports each piece by its own fate.
    await a.request("put", {
      cacheId: "o",
      batch: {
        timestamps: [],
        fields: { price: [], volume: [] },
        meta: { version: "v3" },
      },
    });
    releases[2]?.();
    const got = await pending;
    expect(got.misses).toEqual([
      {
        range: { start: 3, end: 23 },
        reason: "fetch-failed",
        error: { name: "Error", message: "late failure" },
      },
      { range: { start: 33, end: 73 }, reason: "uncached" },
    ]);
  });

  it("a get after updateAuth does not join a fetch started under the old credentials", async () => {
    resetLog("slow");
    const { a, b } = await pair({ token: "old" });
    const releases = captureReleases();
    const first = get(a, { start: 3, end: 13 });
    const second = get(a, { start: 43, end: 53 });
    await new Promise((r) => setTimeout(r, 30));
    log().afterRelease = "auth";
    releases[0]?.();
    await first;
    await b.request("updateAuth", { context: { token: "new" } });
    // Same range as the still-pending old-token fetch: a fresh fetch starts.
    const third = get(b, { start: 43, end: 53 });
    await new Promise((r) => setTimeout(r, 30));
    expect(releases).toHaveLength(3);
    expect(log().requests[2]?.context).toEqual({ token: "new" });
    releases[1]?.();
    expect((await second).misses[0]?.reason).toBe("auth-pending");
    delete log().afterRelease;
    releases[2]?.();
    expect((await third).misses).toEqual([]);
  });
});

describe("round 3 regressions", () => {
  it("a fence retry does not join a fetch that the same clear already made stale", async () => {
    resetLog("slow");
    const { a, b } = await pair();
    await a.request("put", {
      cacheId: "o",
      batch: {
        timestamps: [],
        fields: { price: [], volume: [] },
        meta: { version: "v1" },
      },
    });
    const releases = captureReleases();
    const wide = get(a, { start: 3, end: 73 });
    await new Promise((r) => setTimeout(r, 20));
    await a.request("put", {
      cacheId: "o",
      batch: {
        timestamps: [23, 33, 43, 53],
        fields: { price: [23, 33, 43, 53], volume: [0, 0, 0, 0] },
      },
      options: { range: { start: 23, end: 53 } },
    });
    const flanked = get(b, { start: 3, end: 73 });
    await new Promise((r) => setTimeout(r, 20));
    expect(releases).toHaveLength(3);
    // A version clear fences all three; the flanks finish first.
    await a.request("put", {
      cacheId: "o",
      batch: {
        timestamps: [],
        fields: { price: [], volume: [] },
        meta: { version: "v2" },
      },
    });
    releases[1]?.();
    releases[2]?.();
    await new Promise((r) => setTimeout(r, 30));
    // b's retry must be a fresh fetch, not the stale [3,73] still in flight.
    expect(releases.length).toBeGreaterThanOrEqual(4);
    releases[0]?.();
    for (const r of releases.slice(3)) r();
    const got = await flanked;
    expect(got.misses).toEqual([]);
    await wide;
  });

  it("a get during a slow updateAuth answers auth-pending at once instead of fetching with half-swapped credentials", async () => {
    resetLog();
    const { a } = await pair({ token: "old" });
    const authReleases = captureAuthReleases();
    const updating = a.request("updateAuth", { context: { token: "new" } });
    await new Promise((r) => setTimeout(r, 20));
    const during = await Promise.race([
      get(a, { start: 3, end: 13 }),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 200)),
    ]);
    expect(during).not.toBe("timeout");
    expect((during as GetResult).misses[0]?.reason).toBe("auth-pending");
    expect(log().requests).toHaveLength(0);
    authReleases[0]?.();
    await updating;
    const next = await get(a, { start: 3, end: 13 });
    expect(next.misses).toEqual([]);
    expect(log().requests[0]?.context).toEqual({ token: "new" });
  });

  it("concurrent updateAuth calls apply one at a time; a 401 under the latest credentials stays invalid", async () => {
    resetLog();
    const { a, b } = await pair({ token: "t0" });
    const authReleases = captureAuthReleases();
    // Two tabs update at once. Their ports are independent, so the server
    // may see either first; what matters is one transition at a time.
    const updates = Promise.all([
      a.request("updateAuth", { context: { token: "t1" } }),
      b.request("updateAuth", { context: { token: "t2" } }),
    ]);
    await new Promise((r) => setTimeout(r, 20));
    expect(authReleases).toHaveLength(1);
    authReleases[0]?.();
    await new Promise((r) => setTimeout(r, 20));
    expect(authReleases).toHaveLength(2);
    authReleases[1]?.();
    await updates;
    expect(
      log()
        .auth.map((c) => (c as { token: string }).token)
        .sort(),
    ).toEqual(["t0", "t1", "t2"]);
    const latest = log().auth.at(-1);
    log().mode = "auth";
    const seen: Evt[] = [];
    a.on((e) => seen.push(e));
    expect((await get(a, { start: 3, end: 13 })).misses[0]?.reason).toBe(
      "auth-pending",
    );
    log().mode = "ok";
    // Still invalid: nothing fetches until a newer update arrives.
    expect((await get(b, { start: 23, end: 33 })).misses[0]?.reason).toBe(
      "auth-pending",
    );
    expect(log().requests).toHaveLength(1);
    expect(log().requests[0]?.context).toEqual(latest);
    await new Promise((r) => setTimeout(r, 10));
    expect(seen.filter((e) => e.event === "authInvalid")).toHaveLength(1);
  });
});

describe("round 4 regressions", () => {
  it("while auth is invalid a get answers auth-pending at once, even with an updateAuth hook in progress", async () => {
    resetLog("auth");
    const { a } = await pair({ token: "old" });
    expect((await get(a, { start: 3, end: 13 })).misses[0]?.reason).toBe(
      "auth-pending",
    );
    const authReleases = captureAuthReleases();
    const updating = a.request("updateAuth", { context: { token: "new" } });
    // The hook is stalled; this get must not wait for it.
    const quick = await Promise.race([
      get(a, { start: 23, end: 33 }),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 200)),
    ]);
    expect(quick).not.toBe("timeout");
    expect((quick as GetResult).misses[0]?.reason).toBe("auth-pending");
    log().mode = "ok";
    authReleases[0]?.();
    await updating;
    expect((await get(a, { start: 23, end: 33 })).misses).toEqual([]);
  });

  it("a joining tab's context goes through the auth transition, so an old fetch's late 401 is ignored", async () => {
    resetLog("slow");
    const server = new RpcServer(new Engine(), "0.0.0");
    const connect = async (context: unknown) => {
      const channel = new MessageChannel();
      server.attach(channel.port1 as MessagePortLike);
      const client = await PortClient.connect(
        channel.port2 as MessagePortLike,
        {
          fetcher: { module: fetcherModule, context },
        },
      );
      open.push(client);
      return client;
    };
    const a = await connect({ token: "old" });
    await a.request("cache", config);
    const releases = captureReleases();
    const stale = get(a, { start: 3, end: 13 });
    await new Promise((r) => setTimeout(r, 20));
    expect(releases).toHaveLength(1);
    // A second tab joins with fresh credentials and asks for the same range.
    const b = await connect({ token: "new" });
    const fresh = get(b, { start: 3, end: 13 });
    await new Promise((r) => setTimeout(r, 20));
    expect(releases).toHaveLength(2);
    expect(log().requests[1]?.context).toEqual({ token: "new" });
    log().afterRelease = "auth";
    releases[0]?.();
    expect((await stale).misses[0]?.reason).toBe("auth-pending");
    delete log().afterRelease;
    releases[1]?.();
    expect((await fresh).misses).toEqual([]);
  });

  it("a malformed fetcher response is fetch-failed with the PutError, caches nothing, and the next get retries", async () => {
    resetLog("bad");
    const { a } = await pair();
    const got = await get(a, { start: 3, end: 13 });
    expect(got.misses).toEqual([
      {
        range: { start: 3, end: 13 },
        reason: "fetch-failed",
        error: {
          name: "PutError",
          message: expect.stringMatching(/not on the grid/),
        },
      },
    ]);
    expect(Array.from(got.timestamps)).toEqual([]);
    log().mode = "ok";
    expect((await get(a, { start: 3, end: 13 })).misses).toEqual([]);
    expect(log().requests).toHaveLength(2);
  });
});

describe("round 5 regressions", () => {
  it("a 401 landing during a stalled hook does not disturb the transition; the get issued meanwhile is answered at once", async () => {
    resetLog("slow");
    const { a } = await pair({ token: "old" });
    const releases = captureReleases();
    const authReleases = captureAuthReleases();
    const stale = get(a, { start: 3, end: 13 });
    await new Promise((r) => setTimeout(r, 20));
    const updating = a.request("updateAuth", { context: { token: "new" } });
    await new Promise((r) => setTimeout(r, 20));
    const during = await get(a, { start: 43, end: 53 });
    expect(during.misses[0]?.reason).toBe("auth-pending");
    log().afterRelease = "auth";
    releases[0]?.();
    expect((await stale).misses[0]?.reason).toBe("auth-pending");
    authReleases[0]?.();
    await updating;
    delete log().afterRelease;
    log().mode = "ok";
    expect((await get(a, { start: 63, end: 73 })).misses).toEqual([]);
    expect(log().requests.at(-1)?.context).toEqual({ token: "new" });
  });

  it("joining contexts that are not the identical value are treated as new material", async () => {
    resetLog();
    const server = new RpcServer(new Engine(), "0.0.0");
    const connect = async (context: unknown) => {
      const channel = new MessageChannel();
      server.attach(channel.port1 as MessagePortLike);
      const client = await PortClient.connect(
        channel.port2 as MessagePortLike,
        {
          fetcher: { module: fetcherModule, context },
        },
      );
      open.push(client);
      return client;
    };
    await connect(new Map([["token", "old"]]));
    await connect(new Map([["token", "new"]]));
    expect(log().auth).toHaveLength(1);
    expect((log().auth[0] as Map<string, string>).get("token")).toBe("new");
  });

  it("a tab joining while the module is still importing has its context delivered after the load", async () => {
    resetLog();
    const slowModule = dataUrl(
      `await new Promise((r) => setTimeout(r, 60));
       export * from ${JSON.stringify(fetcherModule)};
       export { default } from ${JSON.stringify(fetcherModule)};`,
    );
    const server = new RpcServer(new Engine(), "0.0.0");
    const connect = (context: unknown) => {
      const channel = new MessageChannel();
      server.attach(channel.port1 as MessagePortLike);
      return PortClient.connect(channel.port2 as MessagePortLike, {
        fetcher: { module: slowModule, context },
      });
    };
    const first = connect({ token: "old" });
    await new Promise((r) => setTimeout(r, 10));
    const second = connect({ token: "new" });
    const [a, b] = await Promise.all([first, second]);
    open.push(a, b);
    expect(log().auth).toEqual([{ token: "new" }]);
    await a.request("cache", config);
    await get(a, { start: 3, end: 13 });
    expect(log().requests[0]?.context).toEqual({ token: "new" });
  });
});

describe("round 6 regression", () => {
  it("updateAuth before any fetcher is loaded is inert and leaves nothing for a later fetcher", async () => {
    resetLog();
    const server = new RpcServer(new Engine(), "0.0.0");
    const channel = new MessageChannel();
    server.attach(channel.port1 as MessagePortLike);
    const pull = await PortClient.connect(channel.port2 as MessagePortLike);
    open.push(pull);
    await pull.request("updateAuth", { context: { token: "old" } });
    // A later tab brings the worker's first fetcher, without any context.
    const other = new MessageChannel();
    server.attach(other.port1 as MessagePortLike);
    const fetching = await PortClient.connect(other.port2 as MessagePortLike, {
      fetcher: { module: fetcherModule },
    });
    open.push(fetching);
    await fetching.request("cache", config);
    const got = await get(fetching, { start: 3, end: 13 });
    expect(got.misses).toEqual([]);
    expect(log().requests[0]?.context).toBeUndefined();
    expect(log().auth).toEqual([]);
  });
});

describe("round 7 regressions", () => {
  const slowModule = () =>
    dataUrl(
      `await new Promise((r) => setTimeout(r, 60));
       export { default } from ${JSON.stringify(fetcherModule)};`,
    );

  it("updateAuth during the first import waits for it, so the fetcher's hook hears the material", async () => {
    resetLog();
    const server = new RpcServer(new Engine(), "0.0.0");
    const connect = (init?: { fetcher: { module: string } }) => {
      const channel = new MessageChannel();
      server.attach(channel.port1 as MessagePortLike);
      return PortClient.connect(channel.port2 as MessagePortLike, init);
    };
    const pull = await connect();
    open.push(pull);
    const loading = connect({ fetcher: { module: slowModule() } });
    await new Promise((r) => setTimeout(r, 10));
    await pull.request("updateAuth", { context: { token: "fresh" } });
    const fetching = await loading;
    open.push(fetching);
    expect(log().auth).toEqual([{ token: "fresh" }]);
    await fetching.request("cache", config);
    await get(fetching, { start: 3, end: 13 });
    expect(log().requests[0]?.context).toEqual({ token: "fresh" });
  });

  it("a failed first load leaves no context behind for the next first load", async () => {
    resetLog();
    const server = new RpcServer(new Engine(), "0.0.0");
    const connect = (init?: {
      fetcher: { module: string; context?: unknown };
    }) => {
      const channel = new MessageChannel();
      server.attach(channel.port1 as MessagePortLike);
      return PortClient.connect(channel.port2 as MessagePortLike, init);
    };
    const pull = await connect();
    open.push(pull);
    await expect(
      connect({
        fetcher: {
          module: dataUrl('throw new Error("broken")'),
          context: { token: "old" },
        },
      }),
    ).rejects.toBeInstanceOf(TscacheError);
    const fetching = await connect({ fetcher: { module: fetcherModule } });
    open.push(fetching);
    await fetching.request("cache", config);
    await get(fetching, { start: 3, end: 13 });
    expect(log().requests[0]?.context).toBeUndefined();
  });
});

describe("adversarial regressions", () => {
  it("a fetcher that mutates its request range cannot widen the authoritative write", async () => {
    resetLog();
    const mutating = dataUrl(`
      export default {
        async fetch(req) {
          globalThis.__tsc.requests.push(req);
          req.range.end = req.range.end + 100;
          return { timestamps: [req.range.start], fields: { price: [1], volume: [1] } };
        },
      };
    `);
    const server = new RpcServer(new Engine(), "0.0.0");
    const channel = new MessageChannel();
    server.attach(channel.port1 as MessagePortLike);
    const client = await PortClient.connect(channel.port2 as MessagePortLike, {
      fetcher: { module: mutating },
    });
    open.push(client);
    await client.request("cache", config);
    await client.request("put", {
      cacheId: "o",
      batch: { timestamps: [103], fields: { price: [103], volume: [0] } },
    });
    await get(client, { start: 3, end: 3 });
    // Slot 103 survives and only [3,3] became authoritative.
    const after = await get(
      client,
      { start: 3, end: 103 },
      { cacheOnly: true },
    );
    expect(Array.from(after.timestamps)).toEqual([3, 103]);
    expect(after.coverage).toEqual([
      { start: 3, end: 3 },
      { start: 103, end: 103 },
    ]);
  });

  it("a get waiting on several fetches is released when one of them invalidates auth", async () => {
    resetLog("slow");
    const { a } = await pair({ token: "t" });
    await a.request("put", {
      cacheId: "o",
      batch: {
        timestamps: [23, 33, 43],
        fields: { price: [23, 33, 43], volume: [0, 0, 0] },
      },
      options: { range: { start: 23, end: 43 } },
    });
    const releases = captureReleases();
    const pending = get(a, { start: 3, end: 73 });
    await new Promise((r) => setTimeout(r, 20));
    expect(releases).toHaveLength(2);
    // The left fetch fails with 401; the right one stays out.
    log().afterRelease = "auth";
    releases[0]?.();
    const got = await Promise.race([
      pending,
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 300)),
    ]);
    expect(got).not.toBe("timeout");
    expect((got as GetResult).misses.map((m) => m.reason)).toEqual([
      "auth-pending",
      "auth-pending",
    ]);
    delete log().afterRelease;
    releases[1]?.();
  });
});
