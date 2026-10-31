import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  candleConfig,
  MINUTE,
  pages,
  type Shape,
  series,
} from "../../bench/fixtures";
import { Engine } from "../../src/engine/engine";
import { HostedPersistence } from "../../src/persist/hosted";
import { Persister } from "../../src/persist/persister";
import { PortClient } from "../../src/rpc/port-client";
import type { MessagePortLike } from "../../src/rpc/protocol";
import { RpcServer } from "../../src/rpc/server";
import type { FetchRequest, Range } from "../../src/types";
import { MemoryStore } from "../persist-memory-store";
import { batch, config } from "../persist-test-helpers";

// Persistence budgets (docs/benchmarking.md; docs/reviews/step-38.md,
// slice (a)): they count transactions, records and bytes, so they are exact
// on any machine. The scheduling budgets run under fake timers with the
// persister's defaults.

const writes = (store: MemoryStore) =>
  store.log.filter((call) => call.kind === "write");
const reads = (store: MemoryStore) =>
  store.log.filter((call) => call.kind === "read");

describe("transactions and records (fake timers)", () => {
  beforeEach(() => vi.useFakeTimers({ now: 0 }));
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  /** Makes every flush due now and waits for it under the fake clock. */
  async function flushed(persister: Persister): Promise<void> {
    const done = persister.flush();
    await vi.advanceTimersByTimeAsync(0);
    await done;
  }

  async function opened(overrides: Parameters<typeof config>[0] = {}) {
    const store = new MemoryStore();
    const engine = new Engine();
    const persister = new Persister(engine, async () => store);
    engine.cache(config(overrides));
    await persister.open("persist");
    return { store, engine, persister };
  }

  it("one read per persisted cache opened, none for a cache that is not persisted", async () => {
    const store = new MemoryStore();
    const engine = new Engine();
    const persister = new Persister(engine, async () => store);
    engine.cache(config());
    engine.cache(config({ id: "plain", persist: false }));
    for (let i = 0; i < 3; i++) {
      await persister.open("persist");
      await persister.open("plain");
    }
    expect(reads(store)).toHaveLength(1);
    expect(reads(store)[0]).toMatchObject({ cacheId: "persist" });
  });

  it("50 puts inside one debounce window take one relaxed write", async () => {
    const { store, engine } = await opened({ segmentSlotCap: 64 });
    for (let t = 0; t < 50; t++) engine.put("persist", batch([t]));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(writes(store)).toHaveLength(1);
    expect(writes(store)[0]).toMatchObject({ plan: { strict: false } });
  });

  it("one invalidate takes one strict write", async () => {
    const { store, engine, persister } = await opened();
    engine.put("persist", batch([0, 1, 2]));
    await flushed(persister);
    store.log.length = 0;
    engine.invalidate("persist", { start: 1, end: 1 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(writes(store)).toHaveLength(1);
    expect(writes(store)[0]).toMatchObject({ plan: { strict: true } });
  });

  it("a put inside one page puts that page's record and the cache record", async () => {
    const { store, engine, persister } = await opened();
    engine.put("persist", batch([0, 4, 8]));
    await flushed(persister);
    store.log.length = 0;
    engine.put("persist", batch([5], [50]));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(writes(store)).toHaveLength(1);
    const plan = writes(store)[0]?.plan;
    expect(plan?.putPages.map((p) => p.page)).toEqual([1]);
    expect(plan?.putCache).not.toBeNull();
  });

  it("puts wholly inside the volatile region write nothing", async () => {
    const { store, engine } = await opened({ finalizedUntil: 100 });
    for (let t = 100; t < 150; t++) engine.put("persist", batch([t]));
    engine.put("persist", batch([150, 151]), {
      range: { start: 150, end: 160 },
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(writes(store)).toEqual([]);
  });

  it("a clean load writes nothing", async () => {
    const first = await opened();
    first.engine.put("persist", batch([-1, 0, 3, 4, 7]));
    await flushed(first.persister);
    const store = first.store;
    store.log.length = 0;
    const engine = new Engine();
    const persister = new Persister(engine, async () => store);
    engine.cache(config());
    await persister.open("persist");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reads(store)).toHaveLength(1);
    expect(writes(store)).toEqual([]);
  });
});

describe("a chart scrolling back after a reload (counters.test.ts)", () => {
  const year = series("allDay", 365);
  const served = (): { requests: FetchRequest[] } =>
    (globalThis as unknown as { __persistPerf: { requests: FetchRequest[] } })
      .__persistPerf;
  // The bars of the range asked, authoritative for it.
  const fetcherModule = `data:text/javascript,${encodeURIComponent(`
    export default {
      async fetch(request) {
        const perf = globalThis.__persistPerf;
        perf.requests.push(request);
        return perf.answer(request.range);
      },
    };`)}`;

  function answer({ start, end }: Range) {
    const { timestamps, fields } = year;
    let from = 0;
    while (from < timestamps.length && (timestamps[from] as number) < start) {
      from++;
    }
    let to = from;
    while (to < timestamps.length && (timestamps[to] as number) <= end) to++;
    return {
      timestamps: Array.from(timestamps.subarray(from, to)),
      fields: Object.fromEntries(
        Object.entries(fields).map(([name, column]) => [
          name,
          Array.from((column as Float64Array).subarray(from, to)),
        ]),
      ),
    };
  }

  const clients: PortClient[] = [];
  afterEach(async () => {
    for (const client of clients.splice(0)) await client.dispose();
  });

  /** A worker's engine, persister and server over `store`, and a client. */
  async function session(store: MemoryStore) {
    const engine = new Engine();
    let server: RpcServer | undefined;
    const persistence = new HostedPersistence(
      engine,
      () => import("../../src/persist/lazy"),
      async () => store,
      { onStopped: (event) => server?.persistStopped(event) },
    );
    server = new RpcServer(engine, "0.0.0", undefined, persistence);
    const channel = new MessageChannel();
    server.attach(channel.port1 as MessagePortLike);
    const client = await PortClient.connect(channel.port2 as MessagePortLike, {
      fetcher: { module: fetcherModule },
    });
    clients.push(client);
    const cache = { ...candleConfig("scroll"), persist: true };
    await client.request("cache", cache);
    const persister = persistence.persister;
    if (persister === undefined) throw new Error("the persister did not load");
    const get = (range: Range) =>
      client.request("get", { cacheId: cache.id, range });
    return { get, persister };
  }

  it("fetches nothing on a second server over the first one's flushed store", async () => {
    (globalThis as unknown as { __persistPerf: unknown }).__persistPerf = {
      requests: [],
      answer,
    };
    const SCREEN = 500 * MINUTE;
    const around = (end: number): Range => ({
      start: end - 2 * SCREEN,
      end: end + SCREEN - MINUTE,
    });
    const newest = year.range.end - SCREEN;
    const steps = Array.from({ length: 13 }, (_, i) =>
      around(newest - i * SCREEN),
    );
    const store = new MemoryStore();
    const first = await session(store);
    for (const range of steps) await first.get(range);
    await first.persister.flush();
    expect(served().requests).toHaveLength(13);
    const second = await session(store);
    for (const range of steps) await second.get(range);
    expect(served().requests).toHaveLength(13);
  });
});

describe("stored bytes per bar", () => {
  // The memory budget's fixtures and bounds (memory.test.ts): what the page
  // records of a year of bars hold in payload masks and field buffers.
  for (const [shape, budget] of [
    ["allDay", 36.75],
    ["sessions", 36.75],
    ["dropout", 37.25],
  ] as const) {
    it(`stays within ${budget} B for a year of ${shape} bars`, async () => {
      const bytes = await storedBytesPerBar(shape);
      expect(bytes).toBeLessThanOrEqual(budget);
    });
  }

  async function storedBytesPerBar(shape: Shape): Promise<number> {
    const data = series(shape, 365);
    const store = new MemoryStore();
    const engine = new Engine();
    const persister = new Persister(engine, async () => store);
    const { id } = engine.cache({ ...candleConfig(shape), persist: true });
    await persister.open(id);
    for (const { batch: day, range } of pages(data, 1)) {
      engine.put(id, day, { range });
    }
    await persister.flush();
    let bytes = 0;
    for (const page of store.records(id).pages) {
      for (const segment of page.snapshot.segments) {
        bytes += segment.mask.byteLength;
        for (const field of segment.fields) bytes += field.data.byteLength;
      }
    }
    return bytes / data.timestamps.length;
  }
});
