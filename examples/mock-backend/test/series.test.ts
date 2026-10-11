import { describe, expect, it } from "vitest";
import {
  type Dataset,
  type DatasetName,
  datasets,
  isTradingBar,
} from "../src/datasets";
import { seedOf } from "../src/noise";
import { PAGE_SLOTS, type SeriesPage, seriesPage } from "../src/series";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// Monday 2026-06-01 00:00 UTC.
const MONDAY = Date.UTC(2026, 5, 1);
const LATER = MONDAY + 365 * DAY;

const intervals: Record<DatasetName, number> = {
  candles: 30 * MINUTE,
  metrics: 5000,
  sensor: 10_000,
  events: MINUTE,
};

function page(
  name: DatasetName,
  start: number,
  end: number,
  now = LATER,
  interval = intervals[name],
): SeriesPage {
  const query = { start, end, interval, offset: 0 };
  return seriesPage(datasets[name], seedOf(`${name}/X`), query, now);
}

function rows(p: SeriesPage): Map<number, number[]> {
  const columns = Object.values(p.fields);
  return new Map(
    p.timestamps.map((t, i) => [t, columns.map((c) => c[i] ?? Number.NaN)]),
  );
}

const names = Object.keys(datasets) as DatasetName[];

describe.each(names)("%s", (name) => {
  const interval = intervals[name];
  const span = 400 * interval;

  it("gives every point the same values whichever range asked for it", () => {
    const whole = rows(page(name, MONDAY, MONDAY + span));
    const part = rows(
      page(name, MONDAY + 37 * interval, MONDAY + 211 * interval),
    );
    expect(part.size).toBeGreaterThan(0);
    for (const [t, values] of part) expect(whole.get(t)).toEqual(values);
  });

  it("answers aligned ascending points inside the range, one value per field", () => {
    const start = MONDAY + 7;
    const end = MONDAY + span - 3;
    const p = page(name, start, end);
    expect(p.timestamps.length).toBeGreaterThan(0);
    for (const [i, t] of p.timestamps.entries()) {
      expect(t % interval).toBe(0);
      expect(t).toBeGreaterThanOrEqual(start);
      expect(t).toBeLessThanOrEqual(end);
      if (i > 0) expect(t).toBeGreaterThan(p.timestamps[i - 1] ?? t);
    }
    expect(Object.keys(p.fields)).toEqual(Object.keys(datasets[name].fields));
    for (const column of Object.values(p.fields)) {
      expect(column).toHaveLength(p.timestamps.length);
      for (const value of column) expect(Number.isFinite(value)).toBe(true);
    }
  });

  it("has no points after now and reports the first provisional slot", () => {
    const dataset: Dataset = datasets[name];
    const now = MONDAY + 3 * DAY + 13 * HOUR + 45 * MINUTE + 17_000;
    const p = page(name, now - span, now + span, now);
    for (const t of p.timestamps) expect(t).toBeLessThanOrEqual(now);
    const provisional = dataset.provisionalMs(interval);
    const firstOpen = p.finalizedUntil;
    expect(firstOpen % interval).toBe(0);
    expect(firstOpen + provisional).toBeGreaterThan(now);
    expect(firstOpen - interval + provisional).toBeLessThanOrEqual(now);
  });

  it("never revises a point before the watermark", () => {
    const now = MONDAY + 2 * DAY + 15 * HOUR + 1234;
    const before = page(name, now - span, now, now);
    const after = rows(page(name, now - span, now, now + 10 * interval));
    for (const [t, values] of rows(before)) {
      if (t < before.finalizedUntil) expect(after.get(t)).toEqual(values);
    }
  });
});

describe("paging", () => {
  it("splits a long range into pages that add up to the whole", () => {
    const end = MONDAY + 3 * PAGE_SLOTS * MINUTE;
    const first = page("events", MONDAY, end);
    expect(first.next).toBe(MONDAY + PAGE_SLOTS * MINUTE);
    const collected = new Map(rows(first));
    let next = first.next;
    let pages = 1;
    while (next !== undefined) {
      const p = page("events", next, end);
      for (const [t, values] of rows(p)) collected.set(t, values);
      next = p.next;
      pages++;
    }
    expect(pages).toBe(4);
    const fine = new Map<number, number[]>();
    for (let start = MONDAY; start <= end; start += 1000 * MINUTE) {
      const last = Math.min(end, start + 999 * MINUTE);
      for (const [t, values] of rows(page("events", start, last))) {
        fine.set(t, values);
      }
    }
    expect(collected).toEqual(fine);
  });

  it("stops paging at now", () => {
    const now = MONDAY + 100 * MINUTE;
    const p = page("events", MONDAY, MONDAY + 10 * PAGE_SLOTS * MINUTE, now);
    expect(p.next).toBeUndefined();
  });
});

describe("candles", () => {
  it("trade only in weekday sessions", () => {
    const p = page("candles", MONDAY, MONDAY + 14 * DAY);
    const days = new Set(p.timestamps.map((t) => new Date(t).getUTCDay()));
    expect([...days].sort()).toEqual([1, 2, 3, 4, 5]);
    for (const t of p.timestamps) {
      const minutes = (t % DAY) / MINUTE;
      expect(minutes).toBeGreaterThanOrEqual(13 * 60 + 30);
      expect(minutes).toBeLessThan(20 * 60);
    }
    expect(p.timestamps).toHaveLength(10 * 13);
  });

  it("give daily bars on weekdays only", () => {
    expect(isTradingBar(MONDAY + 5 * DAY, DAY)).toBe(false);
    const p = page("candles", MONDAY, MONDAY + 13 * DAY, LATER, DAY);
    expect(p.timestamps).toHaveLength(10);
  });

  it("keep high and low around open and close", () => {
    const { open, high, low, close } = page("candles", MONDAY, MONDAY + 5 * DAY)
      .fields as Record<string, number[]>;
    for (const [i, o] of (open ?? []).entries()) {
      const c = close?.[i] ?? Number.NaN;
      expect(high?.[i]).toBeGreaterThanOrEqual(Math.max(o, c));
      expect(low?.[i]).toBeLessThanOrEqual(Math.min(o, c));
    }
  });
});

describe("sensor and events", () => {
  it("sensor drops readings and keeps battery an integer percentage", () => {
    const p = page("sensor", MONDAY, MONDAY + 12 * HOUR);
    const slots = (12 * HOUR) / intervals.sensor + 1;
    expect(slots).toBeLessThan(PAGE_SLOTS);
    expect(p.timestamps.length).toBeLessThan(slots);
    expect(p.timestamps.length).toBeGreaterThan(slots * 0.7);
    for (const battery of p.fields.battery ?? []) {
      expect(Number.isInteger(battery)).toBe(true);
      expect(battery).toBeGreaterThanOrEqual(20);
      expect(battery).toBeLessThanOrEqual(100);
    }
  });

  it("events leave most slots empty", () => {
    const p = page("events", MONDAY, MONDAY + 3 * DAY);
    const slots = (3 * DAY) / MINUTE;
    expect(slots).toBeLessThan(PAGE_SLOTS);
    expect(p.timestamps.length).toBeGreaterThan(0);
    expect(p.timestamps.length).toBeLessThan(slots * 0.2);
  });
});
