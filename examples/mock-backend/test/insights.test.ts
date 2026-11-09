import type { CacheHandle, GetResult, Range } from "@anishbenji/tscache";
import type { FetchRequest } from "@anishbenji/tscache/fetcher";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type FetchInsight,
  INSIGHTS_CHANNEL,
  onInsight,
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
    ...overrides,
  };
}

/** Timestamps every minute from `from` to `to`, inclusive. */
function minutes(from: number, to: number): Float64Array {
  const out: number[] = [];
  for (let t = from; t <= to; t += MINUTE) out.push(t);
  return Float64Array.from(out);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("withInsights", () => {
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
    const instrumented = insights.instrument(handle as unknown as CacheHandle);
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
    const instrumented = insights.instrument(handle as unknown as CacheHandle);
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
