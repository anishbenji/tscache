// What the demo pages show about each read: how much of it came from the
// cache and how much from the network. The fetcher runs inside tscache's
// worker, out of the pages' reach, so it is wrapped here: each fetch is
// timed and metered, and reported on a BroadcastChannel every tab of the
// origin hears. The pages match the reports to their reads
// (read-insights.ts). Demo instrumentation only: the library is unchanged.

import type { HostingMode, Range } from "@anishbenji/tscache";
import type {
  Fetcher,
  FetchRequest,
  FetchResponse,
} from "@anishbenji/tscache/fetcher";

/** The BroadcastChannel the fetch reports travel on. */
export const INSIGHTS_CHANNEL = "tscache-demo-insights";

/** One fetch the demo's fetcher made, as it reports it. */
export interface FetchInsight {
  cacheId: string;
  /** The range the cache asked the fetcher for. */
  range: Range;
  /** Bars (points) the fetch returned. */
  bars: number;
  /** Body bytes the backend sent, over every page. */
  bytes: number;
  /** Backend pages the fetch took. */
  pages: number;
  /** How long the fetch took, in ms. */
  ms: number;
  /** When it started and ended, on the shared time line (`moment`). */
  startedAt: number;
  endedAt: number;
  /** Whether it returned data; a failed fetch brought nothing. */
  ok: boolean;
  /**
   * The context the fetcher ran in: one id per worker, drawn when the
   * fetcher module loads, so a new worker reports a new one.
   */
  worker: string;
  /** Where the fetcher ran: a SharedWorker, a dedicated worker or a page. */
  hosting: HostingMode;
  /**
   * The page whose fetcher context the fetch ran with (`pageContext`), if
   * any. A dedicated or in-process engine serves that page alone; a shared
   * one runs with the latest context any of its tabs gave it.
   */
  page: string | undefined;
}

/** This context's id in the reports (FetchInsight.worker). */
const WORKER = crypto.randomUUID();

/** This page's id, which `pageContext` puts in its fetcher context. */
export const PAGE: string = WORKER;

/**
 * `context` with this page's id added, for createClient's and updateAuth's
 * fetcher context: the fetch reports then name the page, so a page can tell
 * its own dedicated or in-process engine's fetches from another tab's.
 */
export function pageContext<T extends object>(
  context: T,
): T & { insightsPage: string } {
  return { ...context, insightsPage: PAGE };
}

function pageOf(context: unknown): string | undefined {
  if (typeof context !== "object" || context === null) return undefined;
  const page: unknown = (context as { insightsPage?: unknown }).insightsPage;
  return typeof page === "string" ? page : undefined;
}

/** Where this code runs, as the reports name it. */
function hostingHere(): HostingMode {
  const scope = globalThis as {
    SharedWorkerGlobalScope?: abstract new () => unknown;
    DedicatedWorkerGlobalScope?: abstract new () => unknown;
  };
  const is = (ctor: (abstract new () => unknown) | undefined) =>
    typeof ctor === "function" && globalThis instanceof ctor;
  if (is(scope.SharedWorkerGlobalScope)) return "shared";
  if (is(scope.DedicatedWorkerGlobalScope)) return "dedicated";
  return "in-process";
}

const HOSTING = hostingHere();

/**
 * Now, in ms since the epoch at sub-millisecond resolution: the time line a
 * worker and the pages of its origin share, so a page can tell whether a
 * fetch ended during one of its reads.
 */
export function moment(): number {
  return performance.timeOrigin + performance.now();
}

/** What a metered fetch reports as it goes. */
export interface Meter {
  /** One backend page arrived, with a body of `bytes` bytes. */
  page(bytes: number): void;
}

/** A fetcher's fetch that reports each page it reads. */
export type MeteredFetch = (
  request: FetchRequest,
  meter: Meter,
) => Promise<FetchResponse>;

function postInsight(insight: FetchInsight): void {
  const channel = new BroadcastChannel(INSIGHTS_CHANNEL);
  channel.postMessage(insight);
  channel.close();
}

/**
 * Calls `fn` for every fetch any tab's worker of this origin makes; returns
 * the unsubscribe.
 */
export function onInsight(fn: (insight: FetchInsight) => void): () => void {
  const channel = new BroadcastChannel(INSIGHTS_CHANNEL);
  channel.onmessage = (event: MessageEvent<FetchInsight>) => fn(event.data);
  return () => channel.close();
}

/**
 * The fetcher whose every fetch runs `fetch`, timed and metered, and is
 * reported on INSIGHTS_CHANNEL before its answer goes back to the cache. A
 * failed fetch is reported too, and its error rethrown unchanged.
 */
export function withInsights(fetch: MeteredFetch): Fetcher {
  return {
    async fetch(request) {
      let bytes = 0;
      let pages = 0;
      const startedAt = moment();
      const report = (bars: number, ok: boolean) => {
        const endedAt = moment();
        postInsight({
          cacheId: request.cacheId,
          range: request.range,
          bars,
          bytes,
          pages,
          ms: endedAt - startedAt,
          startedAt,
          endedAt,
          ok,
          worker: WORKER,
          hosting: HOSTING,
          page: pageOf(request.context),
        });
      };
      try {
        const response = await fetch(request, {
          page(size) {
            pages++;
            bytes += size;
          },
        });
        report(response.timestamps.length, true);
        return response;
      } catch (error) {
        report(0, false);
        throw error;
      }
    },
  };
}
