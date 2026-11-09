// A demo page's insights into its own reads: for the read on screen, how
// many of its bars came from the cache and how many from the network, and
// how long it took from get() to the chart (time to chart), with the last
// value, the median and the 95th percentile of the page's reads.
//
// A page wraps its cache handle with `instrument`, which times each get(),
// and calls `drawn(result)` right after the chart library's setData
// returned, in the same task. The draw is timed up to the next animation
// frame. The fetch reports come from the fetcher in the worker
// (insights.ts). A read's fetched bars are those in its range that a fetch
// brought while the read was in flight, whichever tab's read started that
// fetch: a read that joined a fetch already in flight says so. The rest
// came from the cache.
//
// The state is one immutable object, replaced on each change, so a
// framework binds it as it binds any store: React with
// useSyncExternalStore, Solid with a signal, a vanilla page with
// `mountInsights`.

import type { CacheHandle, GetResult, Range } from "@anishbenji/tscache";
import { type FetchInsight, moment, onInsight } from "./insights";

/** One read, as drawn. */
export interface ReadInsight {
  /** Bars in the answer. */
  bars: number;
  /** Bars a fetch during the read brought, and so the network. */
  fetchedBars: number;
  /** Fetches that ended during the read and touched its range. */
  fetches: number;
  /** The longest of them, in ms; 0 without one. */
  networkMs: number;
  /** One of them was already in flight when the read began. */
  joined: boolean;
  /** From get() to its answer. */
  getMs: number;
  /** From the answer to the frame after setData returned. */
  drawMs: number;
  /** The two together: time to chart. */
  chartMs: number;
}

/** Time to chart over the page's reads. */
export interface Spread {
  count: number;
  last: number;
  p50: number;
  p95: number;
}

export interface InsightsState {
  /** The read drawn last; none before the first. */
  readonly last: ReadInsight | undefined;
  readonly spread: Spread | undefined;
}

export interface Insights {
  readonly state: InsightsState;
  /** Calls `listener` after each change of `state`; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** `handle`, with each get() timed for this page's insights. */
  instrument(handle: CacheHandle): CacheHandle;
  /**
   * The chart library's setData for `result` has returned: times the draw
   * up to the next frame. Call it in the same task. A result is counted
   * once; one that no instrumented get() returned is ignored.
   */
  drawn(result: GetResult): void;
  dispose(): void;
}

/** A get() that has answered and waits for its draw. */
interface Answered {
  cacheId: string;
  range: Range;
  /** When get() was called and when it answered (moment()). */
  askedAt: number;
  answeredAt: number;
}

/** How many reads the spread is taken over: the page's latest ones. */
const SPREAD_READS = 200;
/** Fetch reports older than this are dropped. */
const KEEP_MS = 120_000;

/** The value at quantile `q` of ascending `sorted` (nearest rank). */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.ceil(q * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] as number;
}

export function spreadOf(times: readonly number[]): Spread | undefined {
  const last = times.at(-1);
  if (last === undefined) return undefined;
  const sorted = [...times].sort((a, b) => a - b);
  return {
    count: times.length,
    last,
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
  };
}

function overlaps(a: Range, b: Range): boolean {
  return a.start <= b.end && b.start <= a.end;
}

/**
 * What a read's answer owes the network: the fetches of its cache that
 * ended while it was in flight and touched its range, and the answer's bars
 * inside the ranges they fetched.
 */
export function provenance(
  read: Answered,
  result: Pick<GetResult, "timestamps">,
  insights: readonly FetchInsight[],
): Pick<
  ReadInsight,
  "bars" | "fetchedBars" | "fetches" | "networkMs" | "joined"
> {
  const during = insights.filter(
    (insight) =>
      insight.ok &&
      insight.cacheId === read.cacheId &&
      insight.endedAt >= read.askedAt &&
      insight.endedAt <= read.answeredAt &&
      overlaps(insight.range, read.range),
  );
  let fetchedBars = 0;
  for (const t of result.timestamps) {
    if (during.some(({ range }) => t >= range.start && t <= range.end)) {
      fetchedBars++;
    }
  }
  return {
    bars: result.timestamps.length,
    fetchedBars,
    fetches: during.length,
    networkMs: Math.max(0, ...during.map((insight) => insight.ms)),
    joined: during.some((insight) => insight.startedAt < read.askedAt),
  };
}

/**
 * The page's insights; one per page. It listens for fetch reports from the
 * first instrumented handle on, so a server that renders the page and never
 * reads through one opens no channel.
 */
export function createInsights(): Insights {
  let state: InsightsState = { last: undefined, spread: undefined };
  const listeners = new Set<() => void>();
  const answered = new WeakMap<GetResult, Answered>();
  let reports: FetchInsight[] = [];
  const times: number[] = [];
  let stop: (() => void) | undefined;
  /** The read drawn last, whose provenance a late report may still change. */
  let shown: { read: Answered; result: GetResult } | undefined;

  function notify(): void {
    for (const listener of listeners) listener();
  }

  /**
   * A fetch report reaches the page on its own channel, not with the answer,
   * and can arrive after the frame the answer was drawn in: it then corrects
   * the read on screen.
   */
  function received(insight: FetchInsight): void {
    reports.push(insight);
    const last = state.last;
    if (shown === undefined || last === undefined) return;
    const now = provenance(shown.read, shown.result, reports);
    if (now.fetches === last.fetches) return;
    state = { ...state, last: { ...last, ...now } };
    notify();
  }

  return {
    get state() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    instrument(handle) {
      stop ??= onInsight(received);
      const get: CacheHandle["get"] = async (range, options) => {
        const askedAt = moment();
        const result = await handle.get(range, options);
        answered.set(result, {
          cacheId: handle.id,
          range,
          askedAt,
          answeredAt: moment(),
        });
        return result;
      };
      // The handle's members read private fields, so each runs on the
      // handle itself; only get() is replaced.
      return new Proxy(handle, {
        get(target, key) {
          if (key === "get") return get;
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
    drawn(result) {
      const read = answered.get(result);
      if (read === undefined) return;
      answered.delete(result);
      requestAnimationFrame(() => {
        const framedAt = moment();
        // Older reports can match no read still waiting for its draw.
        reports = reports.filter((r) => r.endedAt >= framedAt - KEEP_MS);
        const chartMs = framedAt - read.askedAt;
        times.push(chartMs);
        if (times.length > SPREAD_READS) times.shift();
        shown = { read, result };
        state = {
          last: {
            ...provenance(read, result, reports),
            getMs: read.answeredAt - read.askedAt,
            drawMs: framedAt - read.answeredAt,
            chartMs,
          },
          spread: spreadOf(times),
        };
        notify();
      });
    },
    dispose() {
      stop?.();
      listeners.clear();
    },
  };
}

const ms = (value: number) => `${Math.round(value)} ms`;
const bars = (n: number) => `${n} bar${n === 1 ? "" : "s"}`;

/** "from cache N bars · from network M bars (K ms)". */
export function describeSource(read: ReadInsight): string {
  const network =
    read.fetches === 0
      ? "from network 0 bars"
      : `from network ${bars(read.fetchedBars)} (${ms(read.networkMs)})`;
  const joined = read.joined ? " · joined a fetch in flight" : "";
  return `from cache ${bars(read.bars - read.fetchedBars)} · ${network}${joined}`;
}

/** "data → chart X ms (get Y + draw Z)". */
export function describeTiming(read: ReadInsight): string {
  return `data → chart ${ms(read.chartMs)} (get ${ms(read.getMs)} + draw ${ms(read.drawMs)})`;
}

/** "last X ms · p50 Y ms · p95 Z ms over N reads". */
export function describeSpread(spread: Spread): string {
  const reads = `${spread.count} read${spread.count === 1 ? "" : "s"}`;
  return `last ${ms(spread.last)} · p50 ${ms(spread.p50)} · p95 ${ms(spread.p95)} over ${reads}`;
}

/** The three lines a page shows, or placeholders before its first draw. */
export function insightLines(state: InsightsState): {
  source: string;
  timing: string;
  spread: string;
} {
  const { last, spread } = state;
  return {
    source: last === undefined ? "no read drawn yet" : describeSource(last),
    timing: last === undefined ? "data → chart –" : describeTiming(last),
    spread: spread === undefined ? "–" : describeSpread(spread),
  };
}

/** The panel's markup, for a page without a framework. */
export const INSIGHTS_MARKUP = `<p class="insights" data-testid="insights">
  <output data-testid="provenance">no read drawn yet</output><br />
  <output data-testid="time-to-chart">data → chart –</output> ·
  <output data-testid="chart-spread">–</output>
</p>`;

/**
 * Writes the insights into `root`'s panel (INSIGHTS_MARKUP) on each change;
 * returns the unsubscribe.
 */
export function mountInsights(
  root: ParentNode,
  insights: Insights,
): () => void {
  const write = () => {
    const lines = insightLines(insights.state);
    const set = (testId: string, text: string) => {
      const output = root.querySelector(`[data-testid="${testId}"]`);
      if (output !== null) output.textContent = text;
    };
    set("provenance", lines.source);
    set("time-to-chart", lines.timing);
    set("chart-spread", lines.spread);
  };
  write();
  return insights.subscribe(write);
}
