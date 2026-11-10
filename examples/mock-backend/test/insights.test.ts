import type { CacheHandle, GetResult, Range } from "@anishbenji/tscache";
import type { FetchRequest } from "@anishbenji/tscache/fetcher";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type FetchInsight,
  INSIGHTS_CHANNEL,
  onInsight,
  PAGE,
  pageContext,
  withInsights,
} from "../src/insights";
import {
  createInsights,
  describeSource,
  describeSpread,
  describeTiming,
  insightLines,
  provenance,
  quantile,
  retainedReports,
  spreadOf,
} from "../src/read-insights";

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 5, 1);

function request(range: Range): FetchRequest {
  return {
    cacheId: "crypto/BTC",
    range,
    interval: MINUTE,
    alignmentOffset: 0,
    context: {},
  };
}

function nextInsight(): Promise<FetchInsight> {
  return new Promise((resolve) => {
    const stop = onInsight((insight) => {
      stop();
      resolve(insight);
    });
  });
}

function insight(overrides: Partial<FetchInsight>): FetchInsight {
  return {
    cacheId: "crypto/BTC",
    range: { start: T0, end: T0 + 9 * MINUTE },
    bars: 10,
    bytes: 100,
    pages: 1,
    ms: 300,
    startedAt: 1000,
    endedAt: 1300,
    ok: true,
    worker: "worker-1",
    hosting: "shared",
    page: "page-1",
    ...overrides,
  };
}

/** Timestamps every minute from `from` to `to`, inclusive. */
function minutes(from: number, to: number): Float64Array {
  const out: number[] = [];
  for (let t = from; t <= to; t += MINUTE) out.push(t);
  return Float64Array.from(out);
}

/** A client on the shared worker, as the instrumented handles' clients. */
const SHARED = { mode: "shared" as const };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pageContext", () => {
  it("adds the page's id to a fetcher context, keeping the rest", () => {
    expect(pageContext({ token: "t" })).toEqual({
      token: "t",
      insightsPage: PAGE,
    });
  });
});

describe("withInsights", () => {
  it("names the page whose context the fetch ran with, and its hosting", async () => {
    const fetcher = withInsights(async () => ({ timestamps: [], fields: {} }));
    const range = { start: T0, end: T0 };
    const reported = nextInsight();
    await fetcher.fetch({ ...request(range), context: pageContext({}) });
    // This test runs in Node, outside any worker: in-process.
    expect(await reported).toMatchObject({ page: PAGE, hosting: "in-process" });
  });

  it("reports each fetch with its range, bars, bytes and pages", async () => {
    const fetcher = withInsights(async (_request, meter) => {
      meter.page(120);
      meter.page(80);
      return { timestamps: [T0, T0 + MINUTE, T0 + 2 * MINUTE], fields: {} };
    });
    const range = { start: T0, end: T0 + 2 * MINUTE };
    const reported = nextInsight();
    const response = await fetcher.fetch(request(range));
    expect(response.timestamps).toHaveLength(3);
    const seen = await reported;
    expect(seen).toMatchObject({
      cacheId: "crypto/BTC",
      range,
      bars: 3,
      bytes: 200,
      pages: 2,
      ok: true,
    });
    expect(seen.endedAt).toBeGreaterThanOrEqual(seen.startedAt);
    // One id per context: the same for every fetch the module makes.
    const again = nextInsight();
    await fetcher.fetch(request(range));
    expect((await again).worker).toBe(seen.worker);
    expect(seen.ms).toBe(seen.endedAt - seen.startedAt);
  });

  it("reports a failed fetch and rethrows its error unchanged", async () => {
    const failure = new Error("down");
    const fetcher = withInsights(async () => {
      throw failure;
    });
    const reported = nextInsight();
    await expect(fetcher.fetch(request({ start: T0, end: T0 }))).rejects.toBe(
      failure,
    );
    expect(await reported).toMatchObject({ bars: 0, ok: false });
  });
});

describe("provenance", () => {
  const read = {
    cacheId: "crypto/BTC",
    range: { start: T0, end: T0 + 19 * MINUTE },
    askedAt: 1000,
    answeredAt: 2000,
    engine: { mode: "shared" as const, page: "page-1" },
  };
  const result = { timestamps: minutes(T0, T0 + 19 * MINUTE) };

  it("counts the bars inside ranges fetched while the read was in flight", () => {
    const fetched = insight({
      range: { start: T0 + 15 * MINUTE, end: T0 + 25 * MINUTE },
      startedAt: 1100,
      endedAt: 1500,
      ms: 400,
    });
    expect(provenance(read, result, [fetched])).toEqual({
      bars: 20,
      fetchedBars: 5,
      fetches: 1,
      networkMs: 400,
      joined: false,
    });
  });

  it("calls a fetch that began before the read a join", () => {
    const joined = insight({ startedAt: 500, endedAt: 1200 });
    expect(provenance(read, result, [joined])).toMatchObject({
      fetchedBars: 10,
      joined: true,
    });
  });

  it("leaves to the cache what fetches outside the read brought", () => {
    const reports = [
      // Ended before the read began: its bars were in the cache already.
      insight({ startedAt: 100, endedAt: 900 }),
      // Ended after the answer.
      insight({ startedAt: 1900, endedAt: 2100 }),
      // Another cache, a failed fetch, a range the read does not touch.
      insight({ cacheId: "crypto/ETH", endedAt: 1500 }),
      insight({ ok: false, endedAt: 1500 }),
      insight({
        range: { start: T0 + 30 * MINUTE, end: T0 + 40 * MINUTE },
        endedAt: 1500,
      }),
    ];
    expect(provenance(read, result, reports)).toEqual({
      bars: 20,
      fetchedBars: 0,
      fetches: 0,
      networkMs: 0,
      joined: false,
    });
  });

  it("leaves out the fetches of an engine that does not serve the read", () => {
    // Two tabs fell back to dedicated workers of their own, on one cache id:
    // tab B's overlapping fetch brought tab A nothing.
    const own = { ...read, engine: { mode: "dedicated" as const, page: "A" } };
    const during = { startedAt: 1100, endedAt: 1500 };
    const theirs = insight({ ...during, hosting: "dedicated", page: "B" });
    const mine = insight({ ...during, hosting: "dedicated", page: "A" });
    expect(provenance(own, result, [theirs]).fetches).toBe(0);
    expect(provenance(own, result, [mine]).fetchedBars).toBe(10);
    // Nor do a shared worker's fetches serve a dedicated engine.
    const shared = insight({ ...during, hosting: "shared", page: "A" });
    expect(provenance(own, result, [shared]).fetches).toBe(0);
    // A shared engine serves every tab on it, whichever tab's context the
    // fetch carried; another tab's private engine serves none of them.
    expect(
      provenance(read, result, [insight({ ...during, page: "B" })]).fetches,
    ).toBe(1);
    expect(provenance(read, result, [mine]).fetches).toBe(0);
  });
});

describe("retainedReports", () => {
  const at = (endedAt: number) => insight({ endedAt });

  it("keeps what a tracked read can still match, and the recent rest", () => {
    const reports = [at(100), at(1500), at(5000), at(9000), at(9500)];
    const reads = [
      // Shown, answered: only reports inside its window can change it.
      { askedAt: 1000, answeredAt: 2000 },
      // In flight: any report that ends from now on.
      { askedAt: 9400 },
    ];
    expect(retainedReports(reports, reads, 1000).map((r) => r.endedAt)).toEqual(
      [1500, 9000, 9500],
    );
  });

  it("keeps at most `cap` reports no answered read can match, the newest", () => {
    const recent = Array.from({ length: 300 }, (_, i) => at(10_000 + i));
    const kept = retainedReports(recent, [], 120_000, 100);
    expect(kept).toHaveLength(100);
    expect(kept[0]?.endedAt).toBe(10_200);
  });

  it("never drops for the cap a report an answered read can match", () => {
    // The read waiting for its frame (or on screen) owns the reports that
    // ended while it was in flight; the cap drops only the others.
    const reads = [{ askedAt: 0, answeredAt: 10 }];
    const own = [at(5), at(6)];
    const recent = Array.from({ length: 300 }, (_, i) => at(10_000 + i));
    const kept = retainedReports([...own, ...recent], reads, 120_000, 100);
    expect(kept).toHaveLength(102);
    expect(kept.slice(0, 2)).toEqual(own);
  });

  it("stays bounded when the page has stopped drawing", () => {
    // A history tab on screen since 1000, while a polling tab reports a
    // fetch every second for an hour.
    const shown = [{ askedAt: 1000, answeredAt: 2000 }];
    let reports: FetchInsight[] = [];
    for (let t = 10_000; t < 3_610_000; t += 1000) {
      reports = retainedReports([...reports, at(t)], shown, 120_000);
    }
    expect(reports.length).toBeLessThanOrEqual(121);
  });
});

describe("quantile and spreadOf", () => {
  it("takes the nearest rank", () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(quantile(sorted, 0.5)).toBe(5);
    expect(quantile(sorted, 0.95)).toBe(10);
    expect(quantile([7], 0.95)).toBe(7);
    expect(quantile([], 0.5)).toBeNaN();
  });

  it("keeps the last value as it came", () => {
    expect(spreadOf([30, 10, 20])).toEqual({
      count: 3,
      last: 20,
      p50: 20,
      p95: 30,
    });
    expect(spreadOf([])).toBeUndefined();
  });
});

describe("the labels", () => {
  const read = {
    bars: 120,
    fetchedBars: 20,
    fetches: 1,
    networkMs: 301.6,
    joined: false,
    getMs: 310.2,
    drawMs: 12.4,
    chartMs: 322.6,
    hidden: false,
  };

  it("name the cache's and the network's share", () => {
    expect(describeSource(read)).toBe(
      "from cache 100 bars · from network 20 bars (302 ms)",
    );
    expect(describeSource({ ...read, joined: true })).toBe(
      "from cache 100 bars · from network 20 bars (302 ms) · joined a fetch in flight",
    );
    expect(
      describeSource({ ...read, fetchedBars: 0, fetches: 0, networkMs: 0 }),
    ).toBe("from cache 120 bars · from network 0 bars");
    expect(
      describeSource({ ...read, bars: 1, fetchedBars: 1, networkMs: 50 }),
    ).toBe("from cache 0 bars · from network 1 bar (50 ms)");
  });

  it("split time to chart into get and draw", () => {
    expect(describeTiming(read)).toBe(
      "data → chart 323 ms (get 310 ms + draw 12 ms)",
    );
    expect(describeTiming({ ...read, hidden: true })).toBe(
      "data → chart 323 ms (get 310 ms + draw 12 ms) · page hidden, not in p50/p95",
    );
  });

  it("give the spread, and placeholders before the first draw", () => {
    expect(describeSpread({ count: 2, last: 9, p50: 8, p95: 9.4 })).toBe(
      "last 9 ms · p50 8 ms · p95 9 ms over 2 reads",
    );
    expect(insightLines({ last: undefined, spread: undefined })).toEqual({
      source: "no read drawn yet",
      timing: "data → chart –",
      spread: "–",
    });
  });
});

describe("createInsights", () => {
  it("times an instrumented get() and its draw, once per result", async () => {
    const frames: (() => void)[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
      frames.push(callback);
      return frames.length;
    });
    const range = { start: T0, end: T0 + 4 * MINUTE };
    const answer = {
      timestamps: minutes(range.start, range.end),
      fields: {},
      coverage: [range],
      misses: [],
    } satisfies GetResult;
    class Handle {
      readonly id = "crypto/BTC";
      #reads = 0;
      async get(): Promise<GetResult> {
        this.#reads++;
        return answer;
      }
      reads(): number {
        return this.#reads;
      }
    }
    const handle = new Handle();
    const insights = createInsights();
    const changes: unknown[] = [];
    insights.subscribe(() => changes.push(insights.state));
    const instrumented = insights.instrument(
      handle as unknown as CacheHandle,
      SHARED,
    ) as unknown as Handle;

    const result = await instrumented.get();
    // Members other than get() run on the handle, private fields and all.
    expect(instrumented.reads()).toBe(1);
    expect(instrumented.id).toBe("crypto/BTC");
    insights.drawn(result);
    insights.drawn(result);
    expect(frames).toHaveLength(1);
    frames[0]?.();
    expect(changes).toHaveLength(1);
    const { last, spread } = insights.state;
    expect(last).toMatchObject({ bars: 5, fetchedBars: 0, fetches: 0 });
    expect(last?.chartMs).toBeCloseTo((last?.getMs ?? 0) + (last?.drawMs ?? 0));
    expect(spread?.count).toBe(1);

    // A result no instrumented get() returned is not a read of this page.
    insights.drawn({ ...answer });
    expect(frames).toHaveLength(1);
    insights.dispose();
  });
  it("corrects the read on screen when its fetch report arrives late", async () => {
    const frames: (() => void)[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
      frames.push(callback);
      return frames.length;
    });
    // The page's clock: asked at 1000, answered at 1100, drawn at 1200.
    const ticks = [1000, 1100, 1200];
    vi.spyOn(performance, "now").mockImplementation(() => ticks.shift() ?? 0);
    const origin = performance.timeOrigin;
    const range = { start: T0, end: T0 + 9 * MINUTE };
    const answer = {
      timestamps: minutes(range.start, range.end),
      fields: {},
      coverage: [range],
      misses: [],
    } satisfies GetResult;
    const handle = { id: "crypto/BTC", get: async () => answer };
    const insights = createInsights();
    const instrumented = insights.instrument(
      handle as unknown as CacheHandle,
      SHARED,
    );
    const result = await instrumented.get(range);
    insights.drawn(result);
    frames[0]?.();
    expect(insights.state.last).toMatchObject({ fetchedBars: 0, fetches: 0 });

    const corrected = new Promise<void>((resolve) => {
      insights.subscribe(resolve);
    });
    const channel = new BroadcastChannel(INSIGHTS_CHANNEL);
    channel.postMessage(
      insight({
        range: { start: T0 + 5 * MINUTE, end: T0 + 9 * MINUTE },
        startedAt: origin + 1010,
        endedAt: origin + 1090,
      }),
    );
    channel.close();
    await corrected;
    expect(insights.state.last).toMatchObject({ fetchedBars: 5, fetches: 1 });
    expect(insights.state.spread?.count).toBe(1);
    insights.dispose();
    vi.restoreAllMocks();
  });

  it("does not credit another engine's fetch to a read of its cache", async () => {
    const frames: (() => void)[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
      frames.push(callback);
      return frames.length;
    });
    const ticks = [1000, 1100, 1200];
    vi.spyOn(performance, "now").mockImplementation(() => ticks.shift() ?? 0);
    const origin = performance.timeOrigin;
    const range = { start: T0, end: T0 + 9 * MINUTE };
    const answer = {
      timestamps: minutes(range.start, range.end),
      fields: {},
      coverage: [range],
      misses: [],
    } satisfies GetResult;
    const handle = { id: "crypto/BTC", get: async () => answer };
    const insights = createInsights();
    // This tab fell back to a dedicated worker of its own.
    const instrumented = insights.instrument(handle as unknown as CacheHandle, {
      mode: "dedicated",
    });
    const result = await instrumented.get(range);
    insights.drawn(result);
    frames[0]?.();
    // Another tab's dedicated worker fetched an overlapping range during
    // the read, and its report arrives now; then this tab's own does.
    const changed = new Promise<void>((resolve) => {
      insights.subscribe(resolve);
    });
    const during = { startedAt: origin + 1010, endedAt: origin + 1090 };
    const channel = new BroadcastChannel(INSIGHTS_CHANNEL);
    channel.postMessage(
      insight({ ...during, range, hosting: "dedicated", page: "another tab" }),
    );
    channel.postMessage(
      insight({
        ...during,
        range: { start: T0 + 5 * MINUTE, end: T0 + 9 * MINUTE },
        hosting: "dedicated",
        page: PAGE,
      }),
    );
    channel.close();
    await changed;
    // Only this tab's fetch counts: five bars, not ten.
    expect(insights.state.last).toMatchObject({ fetchedBars: 5, fetches: 1 });
    insights.dispose();
    vi.restoreAllMocks();
  });

  it("keeps one pending frame, the latest read's, while frames are withheld", async () => {
    // A hidden page polls on: each read is drawn, but no frame comes.
    const frames = new Map<number, () => void>();
    let ids = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
      frames.set(++ids, callback);
      return ids;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    const insights = createInsights();
    let reads = 0;
    const handle = {
      id: "crypto/BTC",
      get: async (): Promise<GetResult> => {
        reads++;
        const range = { start: T0, end: T0 + reads * MINUTE };
        return {
          timestamps: minutes(range.start, range.end),
          fields: {},
          coverage: [range],
          misses: [],
        };
      },
    };
    const instrumented = insights.instrument(
      handle as unknown as CacheHandle,
      SHARED,
    );
    for (let i = 0; i < 200; i++) {
      insights.drawn(await instrumented.get({ start: T0, end: T0 }));
    }
    // Each draw replaced the one before: one frame waits, holding one read.
    expect(frames.size).toBe(1);
    for (const frame of frames.values()) frame();
    expect(insights.state.last?.bars).toBe(201);
    expect(insights.state.spread?.count).toBe(1);
    insights.dispose();
  });

  it("keeps a read's fetch through a frame a hidden page held back", async () => {
    const frames: (() => void)[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
      frames.push(callback);
      return frames.length;
    });
    const page = Object.assign(new EventTarget(), {
      visibilityState: "visible" as DocumentVisibilityState,
    });
    vi.stubGlobal("document", page);
    // Asked at 1000, answered at 1100; the frame comes ten minutes later,
    // once the page is shown again.
    const ticks = [1000, 1100, 1000 + 10 * 60_000];
    vi.spyOn(performance, "now").mockImplementation(() => ticks.shift() ?? 0);
    const origin = performance.timeOrigin;
    const range = { start: T0, end: T0 + 9 * MINUTE };
    const answer = {
      timestamps: minutes(range.start, range.end),
      fields: {},
      coverage: [range],
      misses: [],
    } satisfies GetResult;
    const handle = { id: "crypto/BTC", get: async () => answer };
    const insights = createInsights();
    const instrumented = insights.instrument(
      handle as unknown as CacheHandle,
      SHARED,
    );
    // The read's own fetch, reported before its answer.
    const reported = new Promise<void>((resolve) => {
      const stop = onInsight(() => {
        stop();
        resolve();
      });
    });
    const channel = new BroadcastChannel(INSIGHTS_CHANNEL);
    channel.postMessage(
      insight({ range, startedAt: origin + 1010, endedAt: origin + 1090 }),
    );
    channel.close();
    await reported;
    const result = await instrumented.get(range);
    insights.drawn(result);
    page.visibilityState = "hidden";
    page.dispatchEvent(new Event("visibilitychange"));
    page.visibilityState = "visible";
    page.dispatchEvent(new Event("visibilitychange"));
    frames[0]?.();

    expect(insights.state.last).toMatchObject({
      fetchedBars: 10,
      fetches: 1,
      hidden: true,
    });
    expect(insights.state.last?.chartMs).toBe(10 * 60_000);
    // The ten minutes measure the hiding, not the chart.
    expect(insights.state.spread).toBeUndefined();
    insights.dispose();
    vi.restoreAllMocks();
  });
});
