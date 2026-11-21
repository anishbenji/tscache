import { afterEach, describe, expect, it, vi } from "vitest";
import { candleConfig, MINUTE, series } from "../../bench/fixtures";
import { CacheState } from "../../src/engine/cache";
import { Engine } from "../../src/engine/engine";
import { Orchestrator } from "../../src/orchestrator/orchestrator";
import { PortClient } from "../../src/rpc/port-client";
import type { MessagePortLike } from "../../src/rpc/protocol";
import { RpcServer } from "../../src/rpc/server";
import { DenseSegment } from "../../src/segment/dense";
import type { GetResult, Range } from "../../src/types";

// Performance budgets for M3 (docs/benchmarking.md; architecture §2.9,
// cost): counted, not timed, so exact on any machine. With a budget set, a
// read moves only the pages it overlaps and costs no message, and a write
// re-counts only the pages it touched; without one neither does anything.
// The stress case reads 50 series through a budget that holds a few.

/** A year of 24/7 bars: 17 pages of the default slot cap. */
const year = series("allDay", 365);
const SCREEN = 500 * MINUTE;
/** A chart's read for the newest screen, a screen each side. */
const viewport: Range = {
  start: year.range.end - 3 * SCREEN,
  end: year.range.end - MINUTE,
};
const MB = 1_000_000;

/** The response for `range`: the year's bars inside it, as typed arrays. */
function answer({ start, end }: Range) {
  const { timestamps, fields } = year;
  let from = 0;
  while (from < timestamps.length && (timestamps[from] as number) < start) {
    from++;
  }
  let to = from;
  while (to < timestamps.length && (timestamps[to] as number) <= end) to++;
  return {
    timestamps: timestamps.subarray(from, to),
    fields: Object.fromEntries(
      Object.entries(fields).map(([name, column]) => [
        name,
        column.subarray(from, to),
      ]),
    ),
  };
}

const fetcherModule = `data:text/javascript,${encodeURIComponent(`
  export default { async fetch(request) {
    return globalThis.__perfMemory(request.range);
  } };
`)}`;
(globalThis as unknown as { __perfMemory: typeof answer }).__perfMemory =
  answer;

/** Counts the pages each read or write moves in the use order. */
function countPages(): { pages: number } {
  const counted = { pages: 0 };
  const original = CacheState.prototype.forEachPage;
  vi.spyOn(CacheState.prototype, "forEachPage").mockImplementation(function (
    this: CacheState,
    slots,
    fn,
  ) {
    original.call(this, slots, (page) => {
      counted.pages++;
      fn(page);
    });
  });
  return counted;
}

/** Counts how often a segment's byte count is read. */
function countByteReads(): { reads: number } {
  const counted = { reads: 0 };
  const descriptor = Object.getOwnPropertyDescriptor(
    DenseSegment.prototype,
    "bytes",
  ) as PropertyDescriptor;
  const get = descriptor.get as () => number;
  vi.spyOn(DenseSegment.prototype, "bytes", "get").mockImplementation(function (
    this: DenseSegment,
  ) {
    counted.reads++;
    return get.call(this);
  });
  return counted;
}

function filled(engine: Engine): string {
  const { id } = engine.cache(candleConfig("perf"));
  engine.put(id, answer(year.range), { range: year.range });
  return id;
}

const open: PortClient[] = [];
afterEach(() => {
  for (const client of open.splice(0)) client.dispose();
  vi.restoreAllMocks();
});

/** Messages one cached read costs through the port. */
async function messagesPerRead(engine: Engine): Promise<number> {
  const channel = new MessageChannel();
  let messages = 0;
  const port = channel.port2;
  const counted: MessagePortLike = {
    postMessage(message, transfer = []) {
      messages++;
      port.postMessage(message, transfer);
    },
    addEventListener: (type, fn) =>
      port.addEventListener(type, fn as EventListener),
    removeEventListener: (type, fn) =>
      port.removeEventListener(type, fn as EventListener),
    start: () => port.start(),
    close: () => port.close(),
  };
  new RpcServer(engine, "0.0.0").attach(channel.port1 as MessagePortLike);
  const client = await PortClient.connect(counted, {
    fetcher: { module: fetcherModule },
  });
  open.push(client);
  const cacheId = filled(engine);
  const get = () =>
    client.request("get", { cacheId, range: viewport }) as Promise<GetResult>;
  await get();
  const before = messages;
  expect((await get()).misses).toEqual([]);
  return messages - before;
}

describe("M3 budgets: what a budget costs per call", () => {
  it("a cached read through the port takes one message up with a budget, as without", async () => {
    expect(await messagesPerRead(new Engine({ memoryBudget: 100 * MB }))).toBe(
      await messagesPerRead(new Engine()),
    );
  });

  it("with a budget a viewport read moves its one page, a year's read its 17; without one none", () => {
    const budgeted = new Engine({ memoryBudget: 100 * MB });
    const plain = new Engine();
    const ids = [filled(budgeted), filled(plain)];
    const counted = countPages();
    budgeted.get(ids[0] as string, viewport);
    expect(counted.pages).toBe(1);
    counted.pages = 0;
    budgeted.get(ids[0] as string, year.range);
    expect(counted.pages).toBe(17);
    counted.pages = 0;
    plain.get(ids[1] as string, year.range);
    expect(counted.pages).toBe(0);
  });

  it("with a budget a put re-counts only the page it touched; without one nothing", () => {
    const budgeted = new Engine({ memoryBudget: 100 * MB });
    const plain = new Engine();
    const ids = [filled(budgeted), filled(plain)];
    const reads = countByteReads();
    const pages = countPages();
    const bar = answer({ start: year.range.end, end: year.range.end });
    budgeted.put(ids[0] as string, bar);
    // The page's one segment before and after the write, out of 17 pages.
    expect(reads.reads).toBe(2);
    expect(pages.pages).toBe(1);
    reads.reads = 0;
    pages.pages = 0;
    plain.put(ids[1] as string, bar);
    expect(reads.reads).toBe(0);
    expect(pages.pages).toBe(0);
  });

  // The design's stress case is a year of each of 50 series through a
  // 100 MB budget; this is the same ratio at a twelfth of the size (a month
  // of each of 50 series through 8 MB), so it stays well under a second.
  it("a month of each of 50 series through an 8 MB budget stays at or under it once each read is done", async () => {
    const month = {
      start: year.range.start,
      end: year.range.start + 30 * 1440 * MINUTE - MINUTE,
    };
    const bars = answer(month).timestamps.length;
    const engine = new Engine({ memoryBudget: 8 * MB });
    const orchestrator = new Orchestrator(engine, () => {});
    await orchestrator.load({ module: fetcherModule });
    let peak = 0;
    for (let i = 0; i < 50; i++) {
      const { id } = engine.cache(
        candleConfig(`s${String(i).padStart(2, "0")}`),
      );
      const result = await orchestrator.get(id, month);
      expect(result.misses).toEqual([]);
      expect(result.timestamps.length).toBe(bars);
      const stats = engine.memoryStats();
      expect(stats.pinnedBytes).toBe(0);
      expect(stats.bytes).toBeLessThanOrEqual(8 * MB);
      peak = Math.max(peak, stats.bytes);
    }
    const stats = engine.memoryStats();
    // A few months fit: the oldest series were evicted, the newest kept.
    expect(stats.evictedPages).toBeGreaterThan(40 * 2);
    expect(peak).toBeGreaterThan(6 * MB);
    expect(stats.caches[0]?.pages).toBe(0);
    expect(stats.caches.at(-1)?.pages).toBe(2);
  });
});
