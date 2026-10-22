// One page of a series answer. The backend pages long ranges, as real
// time-series APIs do, so the examples' fetcher has to loop until it holds
// the whole requested range (docs/architecture.md §2.5).

import type { Dataset } from "./datasets";

/** Slots scanned per page, at most. */
export const PAGE_SLOTS = 5000;

export interface SeriesQuery {
  /** Inclusive ms bounds. */
  start: number;
  end: number;
  interval: number;
  offset: number;
}

export interface SeriesPage {
  timestamps: number[];
  fields: Record<string, number[]>;
  /** The first timestamp still provisional when the page was answered. */
  finalizedUntil: number;
  /** Where the next page starts, while the range goes on past this one. */
  next?: number;
}

function alignUp(t: number, interval: number, offset: number): number {
  return Math.ceil((t - offset) / interval) * interval + offset;
}

function alignDown(t: number, interval: number, offset: number): number {
  return Math.floor((t - offset) / interval) * interval + offset;
}

/**
 * The points of `query` from its start, at most PAGE_SLOTS slots and never
 * past `now`: the backend has no data from the future.
 */
export function seriesPage(
  dataset: Dataset,
  seed: number,
  query: SeriesQuery,
  now: number,
): SeriesPage {
  const { start, end, interval, offset } = query;
  const columns = Object.keys(dataset.fields).map((name) => ({
    name,
    values: [] as number[],
  }));
  const timestamps: number[] = [];
  const first = alignUp(start, interval, offset);
  const pageEnd = first + (PAGE_SLOTS - 1) * interval;
  const last = Math.min(end, pageEnd, now);
  for (let t = first; t <= last; t += interval) {
    const values = dataset.point(seed, t, interval, now);
    if (values === undefined) continue;
    timestamps.push(t);
    for (const [i, column] of columns.entries()) {
      column.values.push(values[i] ?? Number.NaN);
    }
  }
  const page: SeriesPage = {
    timestamps,
    fields: Object.fromEntries(columns.map((c) => [c.name, c.values])),
    finalizedUntil:
      alignDown(now - dataset.provisionalMs(interval), interval, offset) +
      interval,
  };
  const next = pageEnd + interval;
  if (next <= Math.min(end, now)) page.next = next;
  return page;
}
