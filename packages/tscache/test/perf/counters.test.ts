import { afterEach, describe, expect, it } from "vitest";
import { candleConfig, MINUTE, series } from "../../bench/fixtures";
import { Engine } from "../../src/engine/engine";
import { collect } from "../../src/engine/read";
import { PortClient } from "../../src/rpc/port-client";
import type { MessagePortLike } from "../../src/rpc/protocol";
import { RpcServer } from "../../src/rpc/server";
import { DenseSegment } from "../../src/segment/dense";
import type { Segment } from "../../src/segment/types";
import type { FetchRequest, GetResult, Range } from "../../src/types";
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
  const server = new RpcServer(new Engine(), "0.0.0");
  server.attach(counting(channel.port1, down));
  const client = await PortClient.connect(counting(channel.port2, up), {
    fetcher: { module: fetcherModule },
  });
  open.push(client);
  const config = candleConfig("perf");
  await client.request("cache", config);
  const get = (range: Range) =>
    client.request("get", { cacheId: config.id, range }) as Promise<GetResult>;
  return { get, up, down };
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
