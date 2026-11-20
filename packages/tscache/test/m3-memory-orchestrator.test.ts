import { afterEach, describe, expect, it, vi } from "vitest";
import { engineMemoryInternals } from "../src/engine/engine";
import { Orchestrator } from "../src/orchestrator/orchestrator";
import { RpcServer } from "../src/rpc/server";
import type { GetResult } from "../src/types";
import {
  batch,
  config,
  fetcherModule,
  fetching,
  MemoryEngine,
  PAGE_BYTES,
  span,
  times,
  type Wire,
  whole,
  wire,
} from "./m3-memory-helpers";
import { deferred } from "./persist-memory-store";

const connections: Wire[] = [];
afterEach(() => {
  for (const w of connections.splice(0)) w.close();
  vi.restoreAllMocks();
});

describe("M3 orchestration and engine-level RPC contracts", () => {
  it("13: a gated second fetch and another connection's pressure cannot evict a get's points", async () => {
    const gate = deferred<void>();
    const entered = deferred<void>();
    const requests = fetching(async ({ range }) => {
      if (range.start === 7) {
        entered.resolve();
        await gate.promise;
      }
      return batch(times(range.start, range.end));
    });
    const engine = new MemoryEngine({ memoryBudget: PAGE_BYTES });
    const server = new RpcServer(engine, "test");
    const a = await wire(server, true);
    const b = await wire(server, true);
    connections.push(a, b);
    await a.client.request("cache", config());
    await b.client.request("cache", config({ id: "b" }));
    await a.client.request("put", { cacheId: "a", batch: batch(times(4, 7)) });
    const pending = a.client.request("get", {
      cacheId: "a",
      range: span(0, 11),
      options: { snapshot: true },
    }) as Promise<GetResult>;
    try {
      await entered.promise;
      // Ordered answer on the second connection is a barrier after the
      // first response's put, while the second fetch remains held.
      await vi.waitFor(() =>
        expect(engine.coverage("a", span(0, 3))).toEqual([span(0, 3)]),
      );
      await b.client.request("put", { cacheId: "b", batch: batch([16, 20]) });
      expect(engine.memoryStats().pinnedBytes).toBe(2 * PAGE_BYTES);
      expect(engine.memoryStats().bytes).toBeGreaterThan(PAGE_BYTES);
    } finally {
      gate.resolve();
      await pending;
    }
    const result = await pending;
    expect(requests.map((r) => r.range)).toEqual([span(0, 4), span(7, 11)]);
    expect([...result.timestamps]).toEqual(times(0, 11));
    expect(result.misses).toEqual([]);
    expect(result.snapshot?.coverage).toEqual([span(0, 11)]);
    expect(engine.memoryStats()).toMatchObject({
      bytes: PAGE_BYTES,
      pinnedBytes: 0,
    });
    expect(engineMemoryInternals(engine).pinnedPages).toBe(0);
    expect(engine.get("a", span(0, 11)).misses.length).toBeGreaterThan(0);
  });

  it("7/13: the pending get pins both one-slot flanks, even before a fetch writes points", async () => {
    const gate = deferred<void>();
    const entered = deferred<void>();
    fetching(async ({ range }) => {
      entered.resolve();
      await gate.promise;
      return batch(times(range.start, range.end));
    });
    const e = new MemoryEngine({ memoryBudget: 2 * PAGE_BYTES });
    e.cache(config());
    e.cache(config({ id: "b" }));
    e.put("a", batch([3]));
    e.put("a", batch([8]));
    const o = new Orchestrator(e, () => {});
    await o.load({ module: fetcherModule });
    const pending = o.get("a", span(4, 7));
    try {
      await entered.promise;
      e.put("b", batch([16]));
      expect([...e.get("a", whole).timestamps]).toEqual([3, 8]);
      expect(e.memoryStats().pinnedBytes).toBe(2 * PAGE_BYTES);
    } finally {
      gate.resolve();
      await pending;
    }
    const result = await pending;
    expect([...result.timestamps]).toEqual(times(4, 7));
    expect(result.misses).toEqual([]);
    expect(e.memoryStats().bytes).toBeLessThanOrEqual(2 * PAGE_BYTES);
    expect(e.memoryStats().pinnedBytes).toBe(0);
  });

  it("13: joined gets retain independent pins until each has copied its result", async () => {
    const gate = deferred<void>();
    const entered = deferred<void>();
    const calls = fetching(async ({ range }) => {
      entered.resolve();
      await gate.promise;
      return batch(times(range.start, range.end));
    });
    const e = new MemoryEngine({ memoryBudget: PAGE_BYTES });
    e.cache(config());
    const o = new Orchestrator(e, () => {});
    await o.load({ module: fetcherModule });
    const a = o.get("a", span(0, 7));
    await entered.promise;
    const b = o.get("a", span(4, 7));
    gate.resolve();
    const [first, second] = await Promise.all([a, b]);
    expect(calls).toHaveLength(1);
    expect([...first.timestamps]).toEqual(times(0, 7));
    expect(first.misses).toEqual([]);
    expect([...second.timestamps]).toEqual(times(4, 7));
    expect(second.misses).toEqual([]);
    expect(e.memoryStats()).toMatchObject({
      bytes: PAGE_BYTES,
      pinnedBytes: 0,
    });
  });

  it("14: authInvalid releases a waiting get's pin; the late fetch put is unpinned and budgeted", async () => {
    const late = deferred<void>();
    const entered = deferred<void>();
    const applied = deferred<void>();
    fetching(async ({ range }) => {
      if (range.start === 7) {
        entered.resolve();
        await late.promise;
        return batch(times(7, 15).filter((t) => t <= range.end));
      }
      await entered.promise;
      throw Object.assign(new Error("auth refused"), {
        code: "tscache:auth-invalid",
      });
    });
    const e = new MemoryEngine({ memoryBudget: PAGE_BYTES });
    e.cache(config());
    e.put("a", batch(times(4, 7)));
    const o = new Orchestrator(e, () => {});
    await o.load({ module: fetcherModule });
    const original = e.put.bind(e);
    vi.spyOn(e, "put").mockImplementation((id, points, options) => {
      const result = original(id, points, options);
      if (points.timestamps.includes(15)) applied.resolve();
      return result;
    });
    const pending = o.get("a", span(0, 15));
    try {
      await entered.promise;
      const result = await pending; // Must settle without releasing the fetch.
      expect(result.misses.some((miss) => miss.reason === "auth-pending")).toBe(
        true,
      );
      expect(e.memoryStats().pinnedBytes).toBe(0);
      expect(engineMemoryInternals(e).pinnedPages).toBe(0);
      expect(e.memoryStats().bytes).toBeLessThanOrEqual(PAGE_BYTES);
    } finally {
      late.resolve();
    }
    await applied.promise;
    expect(e.memoryStats()).toMatchObject({
      bytes: PAGE_BYTES,
      pinnedBytes: 0,
    });
    expect([...e.get("a", whole).timestamps]).toEqual(times(12, 15));
  });

  it.each(["cacheOnly", "no fetcher"])(
    "4/7: %s reads are uses and register no pending-get pin",
    async (mode) => {
      const e = new MemoryEngine({ memoryBudget: 2 * PAGE_BYTES });
      e.cache(config());
      e.put("a", batch([0]));
      e.put("a", batch([4]));
      const requests = fetching();
      const o = new Orchestrator(e, () => {});
      if (mode === "cacheOnly") await o.load({ module: fetcherModule });
      await o.get(
        "a",
        span(0),
        mode === "cacheOnly" ? { cacheOnly: true } : {},
      );
      e.put("a", batch([8]));
      expect([...e.get("a", whole).timestamps]).toEqual([0, 8]);
      expect(requests).toEqual([]);
      expect(e.memoryStats().pinnedBytes).toBe(0);
    },
  );

  it("4: a fetch's put makes its written pages recent across caches", async () => {
    const e = new MemoryEngine({ memoryBudget: 2 * PAGE_BYTES });
    e.cache(config());
    e.cache(config({ id: "b" }));
    e.put("b", batch([16]));
    fetching();
    const o = new Orchestrator(e, () => {});
    await o.load({ module: fetcherModule });
    expect((await o.get("a", span(0, 3))).misses).toEqual([]);
    e.put("a", batch([4]));
    expect([...e.get("b", whole).timestamps]).toEqual([]);
    expect([...e.get("a", whole).timestamps]).toEqual([0, 1, 2, 3, 4]);
  });

  it("4: coverage probes outside the read are not uses", async () => {
    const e = new MemoryEngine({ memoryBudget: 2 * PAGE_BYTES });
    e.cache(config());
    e.put("a", batch([3]));
    e.put("a", batch([8]));
    fetching(async () => {
      throw new Error("offline");
    });
    const o = new Orchestrator(e, () => {});
    await o.load({ module: fetcherModule });
    // Request 4–5, probe 3–6: only the probe touches page 0.
    await o.get("a", span(4, 5));
    e.put("a", batch([12]));
    expect([...e.get("a", whole).timestamps]).toEqual([8, 12]);
  });

  it("12: RPC budget is first-wins and accepted only before the first cache", async () => {
    // Test 12's engine-level switch-on path; client fallback/handshake
    // behaviour belongs to the implementer's test 16, outside this brief.
    const engine = new MemoryEngine();
    const server = new RpcServer(engine, "test");
    const a = await wire(server);
    const b = await wire(server);
    connections.push(a, b);
    type MemoryOp = (
      op: "memoryBudget",
      params: { bytes: number },
    ) => Promise<unknown>;
    const budgetA = a.client.request.bind(a.client) as unknown as MemoryOp;
    const budgetB = b.client.request.bind(b.client) as unknown as MemoryOp;
    await budgetA("memoryBudget", { bytes: PAGE_BYTES });
    await budgetB("memoryBudget", { bytes: 2 * PAGE_BYTES });
    expect(engine.memoryStats().budget).toBe(PAGE_BYTES);
    await a.client.request("cache", config());
    await a.client.request("put", { cacheId: "a", batch: batch([0, 4]) });
    expect(engine.memoryStats().bytes).toBe(PAGE_BYTES);
    const lateEngine = new MemoryEngine();
    lateEngine.cache(config());
    const lateServer = new RpcServer(lateEngine, "test");
    const c = await wire(lateServer);
    connections.push(c);
    await (c.client.request.bind(c.client) as unknown as MemoryOp)(
      "memoryBudget",
      {
        bytes: PAGE_BYTES,
      },
    );
    expect(lateEngine.memoryStats().budget).toBeUndefined();
    // Even an empty cache blocks switch-on (E20).
    lateEngine.put("a", batch([0, 4]));
    expect(lateEngine.memoryStats().bytes).toBe(2 * PAGE_BYTES);
  });
});
