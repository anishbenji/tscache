// The series every reference client charts: one-minute candles of a market
// that trades around the clock, so the live feed moves at any hour. The
// cache id names the series for the fetcher as `<dataset>/<symbol>`, and
// the interval in the id keeps another resolution's cache apart.

import { datasets } from "@examples/mock-backend/datasets";
import type { CacheConfig, GetResult, Range } from "tscache";

export const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const market: CacheConfig = {
  id: "crypto/BTC/1m",
  interval: MINUTE,
  fields: datasets.crypto.fields,
};

/** The live feed's URL for the market (the mock backend's SSE route). */
export const feedUrl = `/api/stream/crypto/BTC?interval=${MINUTE}`;

/** The range a page opens on: the last six hours up to `now`. */
export function openingRange(now: number): Range {
  return { start: now - 6 * HOUR, end: now };
}

/**
 * The range to read for `visible` on screen: one screen more on each side,
 * so a short scroll is answered from the cache. Never past `now`, where
 * the backend has nothing yet.
 */
export function readRange(visible: Range, now: number): Range {
  const span = visible.end - visible.start;
  const end = Math.min(visible.end + span, now);
  return { start: Math.min(visible.start - span, end), end };
}

/**
 * One line about an answer, the same on the server and in the browser for
 * the same answer: no locale, no time zone.
 */
export function summarize({ timestamps, fields }: GetResult): string {
  const close = fields.close?.at(-1);
  const last = Number.isFinite(close) ? (close as number).toFixed(2) : "–";
  return `${timestamps.length} bars, last close ${last}`;
}
