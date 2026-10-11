// The synthetic series the examples chart. Each dataset decides which
// timestamps have a point and what the point holds, as the backend knows it
// at a given time; the field specs double as the examples' cache configs.

import type { Dtype } from "tscache";
import { unit, wander } from "./noise";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface Dataset {
  /** Field name → dtype; `point` returns values in this order. */
  readonly fields: Readonly<Record<string, Dtype>>;
  /** How long a point stays provisional after its timestamp. */
  provisionalMs(interval: number): number;
  /**
   * The point at aligned timestamp `t` (never after `now`) as known at
   * `now`, or undefined when the series has no point there. Once
   * `t + provisionalMs(interval) <= now` the answer no longer depends on
   * `now`: the point is final.
   */
  point(
    seed: number,
    t: number,
    interval: number,
    now: number,
  ): readonly number[] | undefined;
}

// 09:30 to 16:00 New York time during daylight saving, in UTC.
const SESSION_OPEN = 13 * HOUR + 30 * MINUTE;
const SESSION_CLOSE = 20 * HOUR;

/** Whether a bar starting at `t` falls in a weekday trading session. */
export function isTradingBar(t: number, interval: number): boolean {
  const weekday = new Date(t).getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  if (interval >= DAY) return true;
  const sinceMidnight = ((t % DAY) + DAY) % DAY;
  return sinceMidnight >= SESSION_OPEN && sinceMidnight < SESSION_CLOSE;
}

function price(seed: number, t: number): number {
  const drift = wander(seed, t, [
    [90 * DAY, 0.3],
    [10 * DAY, 0.08],
    [DAY, 0.025],
    [HOUR, 0.008],
    [5 * MINUTE, 0.002],
  ]);
  return 100 * Math.exp(drift);
}

/** OHLCV bars in weekday sessions; the bar forming now is provisional. */
const candles: Dataset = {
  fields: { open: "f64", high: "f64", low: "f64", close: "f64", volume: "u32" },
  provisionalMs: (interval) => interval,
  point(seed, t, interval, now) {
    if (!isTradingBar(t, interval)) return undefined;
    const end = Math.min(t + interval, now);
    const open = price(seed, t);
    const close = price(seed, end);
    let high = Math.max(open, close);
    let low = Math.min(open, close);
    for (let i = 1; i < 4; i++) {
      const inside = price(seed, t + ((end - t) * i) / 4);
      high = Math.max(high, inside);
      low = Math.min(low, inside);
    }
    high *= 1 + 0.002 * unit(seed + 1, t);
    low *= 1 - 0.002 * unit(seed + 2, t);
    const tradedHours = Math.min(interval, SESSION_CLOSE - SESSION_OPEN) / HOUR;
    const formed = (end - t) / interval;
    const volume = Math.round(
      1e6 * tradedHours * (0.5 + unit(seed + 3, t)) * formed,
    );
    return [open, high, low, close, volume];
  },
};

/** Server metrics, always present; request counts arrive late. */
const metrics: Dataset = {
  fields: { cpu: "f32", p95: "f32", requests: "u32" },
  provisionalMs: () => 30 * SECOND,
  point(seed, t, interval, now) {
    const load = wander(seed, t, [
      [10 * MINUTE, 1],
      [MINUTE, 0.4],
    ]);
    const cpu = Math.min(
      100,
      Math.max(0, 40 + 25 * load + 6 * (unit(seed + 1, t) - 0.5)),
    );
    const spike = unit(seed + 2, t) > 0.995 ? 4 : 1;
    const p95 =
      (90 +
        30 *
          wander(seed + 3, t, [
            [5 * MINUTE, 1],
            [30 * SECOND, 0.5],
          ])) *
      spike;
    const arrived = Math.min(1, (now - t) / (30 * SECOND));
    const perSecond = 300 + 150 * wander(seed + 5, t, [[HOUR, 1]]);
    const requests = Math.round((interval / SECOND) * perSecond * arrived);
    return [cpu, p95, requests];
  },
};

/** A sensor that drops single readings and goes offline for 15 minutes. */
const sensor: Dataset = {
  fields: { temperature: "f32", humidity: "f32", battery: "u8" },
  provisionalMs: () => 0,
  point(seed, t) {
    if (unit(seed + 1, Math.floor(t / (15 * MINUTE))) < 0.08) return undefined;
    if (unit(seed + 2, t) < 0.02) return undefined;
    const dayPhase = (2 * Math.PI * (((t % DAY) + DAY) % DAY)) / DAY;
    const temperature =
      21 +
      4 * Math.sin(dayPhase - Math.PI / 2) +
      1.5 * wander(seed + 3, t, [[3 * HOUR, 1]]) +
      0.2 * (unit(seed + 4, t) - 0.5);
    const humidity =
      50 +
      12 *
        wander(seed + 5, t, [
          [6 * HOUR, 1],
          [30 * MINUTE, 0.3],
        ]);
    const cycle = 36 * HOUR;
    const charge = (((t % cycle) + cycle) % cycle) / cycle;
    const battery = Math.floor(100 - 80 * charge);
    return [temperature, humidity, battery];
  },
};

/** Event counts: mostly empty slots, with bursts. */
const events: Dataset = {
  fields: { count: "u16" },
  provisionalMs: () => 0,
  point(seed, t) {
    const burst = Math.max(
      0,
      wander(seed, t, [
        [6 * HOUR, 1],
        [30 * MINUTE, 0.5],
      ]),
    );
    if (unit(seed + 1, t) >= 0.01 + 0.2 * burst ** 2) return undefined;
    const count = 1 + Math.floor(-Math.log(1 - unit(seed + 2, t)) * 3);
    return [Math.min(count, 65_535)];
  },
};

export const datasets = {
  candles,
  metrics,
  sensor,
  events,
} as const satisfies Record<string, Dataset>;

export type DatasetName = keyof typeof datasets;

export function isDatasetName(name: string): name is DatasetName {
  return Object.hasOwn(datasets, name);
}
