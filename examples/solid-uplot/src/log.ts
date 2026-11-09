// The page's log, its count of backend fetches and its insights into its
// reads, as module-scope signals: what feeds them (the fetcher's notices and
// reports, tscache events) arrives outside any component.

import {
  type FetchNotice,
  onFetchNotice,
} from "@examples/mock-backend/notices";
import {
  createInsights,
  insightLines,
} from "@examples/mock-backend/read-insights";
import { createSignal } from "solid-js";
import "@examples/mock-backend/insights.css";

interface LogEntry {
  at: number;
  text: string;
}

const [entries, setEntries] = createSignal<LogEntry[]>([]);
const [fetches, setFetches] = createSignal(0);

export { entries, fetches };

/**
 * Where each drawn read's bars came from, and its time to chart: the cache
 * is instrumented with it (session.ts), and each draw reported to it.
 */
export const insights = createInsights();
const [insight, setInsight] = createSignal(insightLines(insights.state));
insights.subscribe(() => setInsight(insightLines(insights.state)));

export { insight };

export function log(text: string): void {
  setEntries((list) => [{ at: Date.now(), text }, ...list].slice(0, 50));
}

export const time = (t: number): string => new Date(t).toLocaleTimeString();

/** A moment within the last day or two, such as "Sat 16:14:10". */
export const moment = (t: number): string =>
  new Date(t).toLocaleString([], {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });

/** A duration such as "18 h 0 min" or "40 s". */
export function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function describe({ cacheId, range, pages, outcome }: FetchNotice): string {
  const span = `${moment(range.start)} – ${moment(range.end)}`;
  return `fetched ${cacheId}, ${duration(range.end - range.start)} (${span}): ${outcome}, ${pages} page(s)`;
}

/**
 * Counts and logs the backend fetches of any tab on this origin; returns
 * the unsubscribe. With a SharedWorker, all tabs share one cache.
 */
export function watchFetches(): () => void {
  return onFetchNotice((notice) => {
    setFetches((n) => n + 1);
    log(describe(notice));
  });
}
