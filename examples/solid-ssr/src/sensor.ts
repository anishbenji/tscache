// The greenhouse sensor as both sides of the page read it: one reading a
// minute, with dropouts and offline blocks where the backend has no point.

import { datasets } from "@examples/mock-backend/datasets";
import type { CacheConfig, GetResult, HostingMode, Range } from "tscache";

export const INTERVAL = 60_000;
export const DAY = 24 * 3_600_000;

export const config: CacheConfig = {
  id: "sensor/GH1/1m",
  interval: INTERVAL,
  fields: datasets.sensor.fields,
};

/** The 24 hours ending at `end`. */
export function lastDay(end: number): Range {
  return { start: end - DAY, end };
}

/**
 * A reading's values, null where the cache holds NaN: the server sends
 * these as JSON, which has no NaN.
 */
export interface Reading {
  at: number;
  temperature: number | null;
  humidity: number | null;
  battery: number | null;
}

/** What the page reports about one get result. */
export interface Figures {
  readings: number;
  /**
   * Covered slots without a reading: the sensor's dropouts and offline
   * blocks, which the cache knows are empty and never fetches again.
   */
  knownEmpty: number;
  /** The newest reading, or null when the range holds none. */
  latest: Reading | null;
}

/** Covered slots minus the readings inside them; both lists are sorted. */
function knownEmpty({ coverage, timestamps }: GetResult): number {
  let empty = 0;
  let i = 0;
  for (const { start, end } of coverage) {
    while (i < timestamps.length && (timestamps[i] as number) < start) i++;
    let inside = 0;
    for (; i < timestamps.length && (timestamps[i] as number) <= end; i++) {
      inside++;
    }
    empty += (end - start) / INTERVAL + 1 - inside;
  }
  return empty;
}

function latest({ timestamps, fields }: GetResult): Reading | null {
  const i = timestamps.length - 1;
  if (i < 0) return null;
  const value = (field: string) => {
    const v = fields[field]?.[i];
    return v === undefined || Number.isNaN(v) ? null : v;
  };
  return {
    at: timestamps[i] as number,
    temperature: value("temperature"),
    humidity: value("humidity"),
    battery: value("battery"),
  };
}

export function figuresOf(result: GetResult): Figures {
  return {
    readings: result.timestamps.length,
    knownEmpty: knownEmpty(result),
    latest: latest(result),
  };
}

/**
 * What one server render read, and so the props the page renders with on
 * both sides: the browser hydrates with these same values.
 */
export interface ServerRead {
  /** The 24 hours the server read, ending at render time. */
  window: Range;
  /** The server client's hosting mode. */
  mode: HostingMode;
  figures: Figures;
  /** Readings the server's cache already held; it fetched the rest. */
  cached: number;
}
