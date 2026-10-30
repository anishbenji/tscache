import { afterEach, describe, expect, it, vi } from "vitest";
import { candleConfig, MINUTE, series } from "../../bench/fixtures";
import { Engine } from "../../src/engine/engine";
import { collect } from "../../src/engine/read";
import type { SlotRange } from "../../src/grid";
import {
  Orchestrator,
  planFetches,
  planRound,
} from "../../src/orchestrator/orchestrator";
import { PortClient } from "../../src/rpc/port-client";
import type { MessagePortLike } from "../../src/rpc/protocol";
import { RpcServer } from "../../src/rpc/server";
import { DenseSegment } from "../../src/segment/dense";
import type { Segment } from "../../src/segment/types";
import type {
  FetchRequest,
  GetOptions,
  GetResult,
  Range,
} from "../../src/types";
import { roundModel } from "../inflight-plan-model";
import { points, schema, store } from "../merge-test-helpers";

// Performance budgets (docs/benchmarking.md) that count instead of time,
// so they are exact on any machine: what a chart scrolling back costs the
// backend, what a read costs the port between page and worker, and how
// many segments a read looks at.

/** A year of 24/7 bars, which the fetcher below serves. */
const year = series("allDay", 365);

/** What the fetcher was asked, read by the tests. */
interface Served {
  requests: FetchRequest[];
  answer(range: Range): unknown;
}
const served = (): Served =>
  (globalThis as unknown as { __perf: Served }).__perf;

// A fetcher module, as the worker imports it: it answers from the fixture
// on globalThis, the bars of the range asked, authoritative for it.
const fetcherSource = `
  export default {
    async fetch(request) {
      const perf = globalThis.__perf;
      perf.requests.push(request);
      return perf.answer(request.range);
    },
  };`;
const fetcherModule = `data:text/javascript,${encodeURIComponent(fetcherSource)}`;

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

/** Counts what crosses a port, and what of it is transferred. */
interface Traffic {
  messages: number;
  /** Bytes of the ArrayBuffers moved, not copied. */
  transferred: number;
  /** ArrayBuffers in a message that were not in its transfer list. */
  copiedBuffers: number;
  /**
   * Bytes the sender still holds after sending: a buffer listed for
   * transfer but not detached would count here (the list alone proves
   * nothing).
   */
  kept: number;
}

function buffersIn(value: unknown, found: Set<ArrayBuffer>): void {
  if (ArrayBuffer.isView(value)) found.add(value.buffer as ArrayBuffer);
  else if (value instanceof ArrayBuffer) found.add(value);
  else if (Array.isArray(value)) for (const v of value) buffersIn(v, found);
  else if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) buffersIn(v, found);
  }
}

/** `port`, with what it sends counted in `traffic`. */
function counting(port: MessagePort, traffic: Traffic): MessagePortLike {
  return {
    postMessage(message, transfer = []) {
      traffic.messages++;
      const moved = new Set(transfer as ArrayBuffer[]);
      for (const buffer of moved) traffic.transferred += buffer.byteLength;
      const all = new Set<ArrayBuffer>();
      buffersIn(message, all);
      for (const buffer of all) if (!moved.has(buffer)) traffic.copiedBuffers++;
      port.postMessage(message, transfer);
      for (const buffer of all) traffic.kept += buffer.byteLength;
    },
    addEventListener: (type, listener) =>
      port.addEventListener(type, listener as EventListener),
    removeEventListener: (type, listener) =>
      port.removeEventListener(type, listener as EventListener),
    start: () => port.start(),
    close: () => port.close(),
  };
}

const open: PortClient[] = [];
afterEach(async () => {
  for (const client of open.splice(0)) await client.dispose();
});

/** A client and a worker's server on one MessageChannel, both counted. */
async function connect() {
  (globalThis as unknown as { __perf: unknown }).__perf = {
    requests: [],
    answer,
  };
  const up: Traffic = {
    messages: 0,
    transferred: 0,
    copiedBuffers: 0,
    kept: 0,
  };
  const down: Traffic = {
    messages: 0,
    transferred: 0,
    copiedBuffers: 0,
    kept: 0,
  };
  const channel = new MessageChannel();
  const engine = new Engine();
  const server = new RpcServer(engine, "0.0.0");
  server.attach(counting(channel.port1, down));
  const client = await PortClient.connect(counting(channel.port2, up), {
    fetcher: { module: fetcherModule },
  });
  open.push(client);
  const config = candleConfig("perf");
  await client.request("cache", config);
  const get = (range: Range) =>
    client.request("get", { cacheId: config.id, range }) as Promise<GetResult>;
  return { get, up, down, engine, client };
}

const SCREEN = 500 * MINUTE;

/** The range a chart reads for a screen ending at `end`: a screen each side. */
const around = (end: number): Range => ({
  start: end - 2 * SCREEN,
  end: end + SCREEN - MINUTE,
});

describe("a chart scrolling back", () => {
  it("fetches each screen of history once, and nothing on the way back", async () => {
    const { get } = await connect();
    const newest = year.range.end - SCREEN;
    // The opening read, then twelve screens back, one at a time.
    const steps = Array.from({ length: 13 }, (_, i) =>
      around(newest - i * SCREEN),
    );
    for (const range of steps) await get(range);
    const requests = served().requests;
    expect(requests).toHaveLength(13);
    // What was fetched, against what the reads needed: the flanks the
    // orchestrator adds (one interval each side) and nothing more.
    const fetched = requests.reduce(
      (sum, { range }) => sum + (range.end - range.start) / MINUTE + 1,
      0,
    );
    const asked =
      ((steps[0] as Range).end - (steps[12] as Range).start) / MINUTE + 1;
    expect(fetched / asked).toBeLessThanOrEqual(1.002);
    // Forward again over what is cached: no fetch.
    for (const range of steps.toReversed()) await get(range);
    expect(served().requests).toHaveLength(13);
  });
});

describe("a cached read through the port", () => {
  it("takes one message each way and moves its columns, copying none", async () => {
    const { get, up, down } = await connect();
    const range = around(year.range.end - SCREEN);
    await get(range);
    const before = { up: { ...up }, down: { ...down } };
    const result = await get(range);
    const bars = result.timestamps.length;
    expect(bars).toBe(1500);
    expect(up.messages - before.up.messages).toBe(1);
    expect(down.messages - before.down.messages).toBe(1);
    // Timestamps (8 B) and the fields (4 × 8 B + 4 B) of every bar.
    expect(down.transferred - before.down.transferred).toBe(bars * (8 + 36));
    expect(down.copiedBuffers).toBe(0);
    // Moved: the worker's side no longer holds the columns it sent.
    expect(down.kept).toBe(0);
  });
});

describe("an orchestrated get", () => {
  it("reads the engine once, whether it fetches or not", async () => {
    (globalThis as unknown as { __perf: unknown }).__perf = {
      requests: [],
      answer,
    };
    const engine = new Engine();
    const orchestrator = new Orchestrator(engine, () => {});
    await orchestrator.load({ module: fetcherModule });
    // The newest bar is provisional, so a live chart's every get misses it.
    const newest = year.range.end;
    const { id } = engine.cache({
      ...candleConfig("tail"),
      finalizedUntil: newest,
    });
    const reads = vi.spyOn(engine, "get");
    const screen = around(newest - SCREEN + MINUTE);
    const readsOf = async (options?: GetOptions) => {
      reads.mockClear();
      const result = await orchestrator.get(id, screen, options);
      return { result, reads: reads.mock.calls.length };
    };

    // The opening read fetches the screen.
    expect((await readsOf()).reads).toBe(1);
    expect(served().requests).toHaveLength(1);
    // A live-tail get fetches the provisional bar again, and reads once.
    const tail = await readsOf({ snapshot: true });
    expect(served().requests).toHaveLength(2);
    expect(tail.reads).toBe(1);
    expect(tail.result.timestamps.length).toBe(1500);
    expect(tail.result.misses).toEqual([
      { range: { start: newest, end: newest }, reason: "uncached" },
    ]);
    expect(tail.result.snapshot?.coverage).toEqual(tail.result.coverage);
    // A cache hit (the screen before the provisional bar): no fetch.
    const history = { start: screen.start, end: newest - MINUTE };
    reads.mockClear();
    const hit = await orchestrator.get(id, history);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(hit.misses).toEqual([]);
    expect(served().requests).toHaveLength(2);
    // Cache-only: no fetch, one read.
    expect((await readsOf({ cacheOnly: true })).reads).toBe(1);
    expect(served().requests).toHaveLength(2);
  });
});

describe("planning fetches over fragmented coverage", () => {
  // Step 36 R1-1: slots [0, 8191] covered, then every odd slot invalidated,
  // leaves 4,096 single-slot ranges around 4,096 single-slot gaps.
  const grid = { interval: 10, alignmentOffset: 0 };
  const fragments = (): SlotRange[] =>
    Array.from({ length: 4096 }, (_, i) => ({ start: 2 * i, end: 2 * i }));
  /** `ranges`, with every element read counted in `count.reads`. */
  function counted(ranges: SlotRange[], count: { reads: number }) {
    return new Proxy(ranges, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) count.reads++;
        return Reflect.get(target, key, receiver);
      },
    });
  }

  it("reads each covered range a few times, not once per gap", () => {
    const count = { reads: 0 };
    const wanted = planFetches(
      { start: 0, end: 8191 },
      counted(fragments(), count),
      counted([], count),
      grid,
    );
    // Every gap extended one slot into its neighbours: one fetch.
    expect(wanted).toEqual([{ start: 0, end: 8191 }]);
    // A sweep to find the gaps and one to extend them: a few reads per
    // range (measured 28,671, 7 per range). Pairwise work read 16,789,503.
    expect(count.reads).toBeLessThanOrEqual(8 * 4096);
  });

  it("subtracts the ranges already failed in one sweep too", () => {
    const count = { reads: 0 };
    // A second pass after a fence drop: the first half's gaps failed.
    const blocked = Array.from({ length: 2048 }, (_, i) => ({
      start: 2 * i + 1,
      end: 2 * i + 1,
    }));
    const wanted = planFetches(
      { start: 0, end: 8191 },
      counted(fragments(), count),
      counted(blocked, count),
      grid,
    );
    expect(wanted).toEqual([{ start: 4096, end: 8191 }]);
    // Measured 26,622; pairwise work read 20,979,711.
    expect(count.reads).toBeLessThanOrEqual(8 * (4096 + 2048));
  });
});

describe("a read among many segments", () => {
  it("looks at a few segments' extents, not every segment's", () => {
    // 8,192 single-point segments, six slots apart (K = 2 splits them).
    const s = store({ gapSplitK: 2, segmentSlotCap: 8 });
    const slots = Array.from({ length: 8192 }, (_, i) => i * 6);
    s.put(points(slots));
    expect(s.segments).toHaveLength(8192);
    let reads = 0;
    const counted = s.segments.map(
      (segment) =>
        new Proxy(segment, {
          get(target, key) {
            if (key === "extent") reads++;
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }) as Segment,
    );
    const last = 8191 * 6;
    const out = collect(counted, { start: last, end: last }, schema);
    expect(Array.from(out.slots)).toEqual([last]);
    // A binary search reads about log2(8192) = 13 extents, and the slice
    // a few more. Measured 14; a scan would read 8,192.
    expect(reads).toBeLessThanOrEqual(24);
  });
});

describe("a segment growing one point at a time", () => {
  it("grows its presence mask a few times, not once per point", () => {
    const grid = { interval: 10, alignmentOffset: 3 };
    const segment = new DenseSegment({ grid, fields: schema, slotCap: 32_768 });
    const NativeUint8Array = globalThis.Uint8Array;
    let masks = 0;
    let maskBytes = 0;
    // Counts Uint8Array construction while the appends run, nothing else.
    const counting = new Proxy(NativeUint8Array, {
      construct(target, args, newTarget) {
        const made = Reflect.construct(target, args, newTarget) as Uint8Array;
        if (made.byteLength > 0) {
          masks++;
          maskBytes += made.byteLength;
        }
        return made;
      },
    });
    globalThis.Uint8Array = counting;
    try {
      // Every other slot: a segment with gaps keeps a presence mask.
      for (let i = 0; i < 16_384; i++) segment.mergeFrom(points([i * 2]));
    } finally {
      globalThis.Uint8Array = NativeUint8Array;
    }
    expect(segment.size).toBe(16_384);
    // At least one: a growth strategy the proxy cannot see (a resizable
    // buffer, a transfer) fails here, loudly, instead of passing on zero.
    expect(masks).toBeGreaterThanOrEqual(1);
    // Doubling reaches 32,768 slots in about a dozen steps; one mask per
    // point would be 16,384.
    expect(masks).toBeLessThanOrEqual(12);
    expect(maskBytes).toBeLessThanOrEqual(12_288);
  });
});

// Step 44 exact budgets: neither elapsed time nor scheduler speed gates these.
describe("N31 round and fast-scroll budgets", () => {
  it.each([false, true])(
    "T6: one round scans 4,096 coverage and in-flight fragments linearly (blocked=%s)",
    (withBlocked) => {
      const grid = { interval: 10, alignmentOffset: 3 };
      const request = { start: 0, end: 16383 };
      const around = Array.from({ length: 4096 }, (_, i) => ({
        start: 4 * i,
        end: 4 * i,
      }));
      const inflight = Array.from({ length: 4096 }, (_, i) => ({
        start: 4 * i + 2,
        end: 4 * i + 2,
      }));
      const blocked = withBlocked
        ? Array.from({ length: 2048 }, (_, i) => ({
            start: 8 * i + 1,
            end: 8 * i + 1,
          }))
        : [];
      const counts = [0, 0, 0];
      const counted = (ranges: SlotRange[], index: number) =>
        new Proxy(ranges, {
          get(target, key, receiver) {
            if (typeof key === "string" && /^\d+$/.test(key))
              counts[index] = (counts[index] ?? 0) + 1;
            return Reflect.get(target, key, receiver);
          },
        });
      const got = planRound(
        request,
        counted(around, 0),
        counted(inflight, 1),
        counted(blocked, 2),
        grid,
      );
      expect(got).toEqual(roundModel(request, around, inflight, blocked));
      // Measured when this contract first turned green: 53,246 element reads
      // over 8,192 elements (6.5 each) without blocked ranges, 55,291 over
      // 10,240 (5.4 each) with them; most are coalesce's neighbour lookups,
      // about five per piece of the need.
      expect(counts.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(
        8 * (around.length + inflight.length + blocked.length),
      );
    },
  );

  it.each(["newest request first", "request order"])(
    "T35: fast scroll fetches exactly 7,501 bars in 13 requests (%s)",
    async (order) => {
      const { get, engine, client } = await connect();
      const newest = year.range.end - SCREEN;
      const first = await get(around(newest));
      expect(first.timestamps).toHaveLength(1500);
      expect(first.coverage).toEqual([around(newest)]);
      expect(first.misses).toEqual([]);
      const releases: (() => void)[] = [];
      served().answer = (range) =>
        new Promise((resolve) => {
          releases.push(() => resolve(answer(range)));
        });
      const reads = vi.spyOn(engine, "get");
      const pending: Promise<GetResult>[] = [];
      try {
        for (let k = 1; k <= 12; k++) {
          const waiting = get(around(newest - k * SCREEN));
          waiting.catch(() => {});
          pending.push(waiting);
          // A non-get round trip confirms the preceding get was planned,
          // without adding an engine read to the exact budget.
          await client.request("cache", candleConfig("perf"));
          expect(served().requests).toHaveLength(k + 1);
          expect(releases).toHaveLength(k);
        }
        expect(reads).toHaveBeenCalledTimes(0);
        const requests = served().requests;
        const fetched = requests.reduce(
          (sum, { range }) => sum + (range.end - range.start) / MINUTE + 1,
          0,
        );
        expect(fetched).toBe(7501);
        expect(requests[1]?.range).toEqual({
          start: newest - 3 * SCREEN,
          end: newest - 2 * SCREEN,
        });
        for (let k = 2; k <= 12; k++)
          expect(requests[k]?.range).toEqual({
            start: newest - (k + 2) * SCREEN,
            end: newest - (k + 1) * SCREEN - MINUTE,
          });
        for (const release of order === "request order"
          ? releases
          : releases.toReversed())
          release();
        const results = await Promise.all(pending);
        for (const [i, got] of results.entries()) {
          const range = around(newest - (i + 1) * SCREEN);
          expect(got.timestamps).toHaveLength(1500);
          expect(got.timestamps[0]).toBe(range.start);
          expect(got.timestamps[1499]).toBe(range.end);
          expect(got.coverage).toEqual([range]);
          expect(got.misses).toEqual([]);
        }
        expect(reads).toHaveBeenCalledTimes(12);
        expect(served().requests).toHaveLength(13);
      } finally {
        for (const release of releases) release();
        await Promise.allSettled(pending);
        reads.mockRestore();
      }
    },
  );
});
