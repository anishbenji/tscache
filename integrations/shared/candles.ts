// The dataset every snippet shows: daily candles. A snippet's view is a
// line of text; a chart library takes the same columns (uPlot's data, a
// Lightweight Charts series), and the snippets mark where it would go.

import type { CacheConfig, GetResult, Range } from "tscache";

export const DAY = 86_400_000;

export const candles: CacheConfig = {
  id: "acme-1d",
  interval: DAY,
  fields: { open: "f64", high: "f64", low: "f64", close: "f64", volume: "f64" },
};

/** The last `days` days up to `now`. */
export function lastDays(days: number, now: number): Range {
  return { start: now - days * DAY, end: now };
}

/**
 * One line about an answer, the same on the server and in the browser for
 * the same answer: no locale, no time zone. NaN is a legal value and shows
 * as a dash.
 */
export function describe({ timestamps, fields, misses }: GetResult): string {
  const close = fields.close?.at(-1);
  const shown = Number.isFinite(close) ? (close as number).toFixed(2) : "–";
  const missing = misses.length > 0 ? `, ${misses.length} not loaded` : "";
  return `${timestamps.length} candles, last close ${shown}${missing}`;
}
