import { describe, expect, it } from "vitest";
import type { GetResult, Range } from "../src/types";
import { rng } from "./cache-model";
import {
  batch,
  type ChangeEvent,
  config,
  id,
  observed,
} from "./m7-change-test-helpers";

interface SlotView {
  value: number | undefined;
  covered: boolean;
}

/** An independent reader: it knows only its initial read and event-triggered reads. */
class Reader {
  readonly slots = new Map<number, SlotView>();

  constructor(
    readonly interval: number,
    readonly times: number[],
  ) {}

  remember(range: Range, result: GetResult): void {
    for (const t of this.times) {
      if (t < range.start || t > range.end) continue;
      const at = result.timestamps.indexOf(t);
      this.slots.set(t, {
        value: at === -1 ? undefined : result.fields.value?.[at],
        covered: result.coverage.some((r) => r.start <= t && t <= r.end),
      });
    }
  }

  result(range: Range): GetResult {
    // Snap by enumerating the small displayed grid, independently of grid.ts.
    const first = this.times.filter((t) => t <= range.start).at(-1);
    const last = this.times.find((t) => t >= range.end);
    if (first === undefined || last === undefined)
      throw new Error("query outside reader view");
    const times = this.times.filter((t) => first <= t && t <= last);
    const present = times.filter((t) => this.slots.get(t)?.value !== undefined);
    const runs = (covered: boolean): Range[] => {
      const ranges: Range[] = [];
      for (const t of times) {
        if (this.slots.get(t)?.covered !== covered) continue;
        const previous = ranges.at(-1);
        if (previous !== undefined && previous.end + this.interval === t)
          previous.end = t;
        else ranges.push({ start: t, end: t });
      }
      return ranges;
    };
    return {
      timestamps: new Float64Array(present),
      fields: {
        value: new Float64Array(
          present.map((t) => this.slots.get(t)?.value as number),
        ),
      },
      coverage: runs(true),
      misses: runs(false).map((r) => ({ range: r, reason: "uncached" })),
    };
  }
}

function normalized(event: ChangeEvent, interval: number): void {
  for (const ranges of [event.written, event.removed]) {
    let previous: Range | undefined;
    for (const range of ranges) {
      expect(Number.isSafeInteger(range.start)).toBe(true);
      expect(Number.isSafeInteger(range.end)).toBe(true);
      expect(range.start).toBeLessThanOrEqual(range.end);
      if (previous !== undefined)
        expect(previous.end + interval).toBeLessThan(range.start);
      previous = range;
    }
  }
  if (event.cleared) expect(event.removed).toEqual([]);
}

describe("M7 event-driven reader property (§5.11)", () => {
  it.each([
    1, 7, 19, 42, 74, 114, 2026, 65537, 0x12345678, 0x7fffffff, 0xdeadbeef,
    0xffffffff,
  ])(
    "a reader of named ranges stays equal to fresh cacheOnly reads, seed=%i",
    (seed) => {
      const r = rng(seed);
      const interval = r.pick([1, 10, 60]);
      const offset = r.int(0, interval - 1);
      const ms = (slot: number): number => offset + interval * slot;
      const times = Array.from({ length: 17 }, (_, i) => ms(i - 8));
      const whole = { start: ms(-8), end: ms(8) };
      const { engine, events, reset } = observed(
        config({
          interval,
          alignmentOffset: offset,
          segmentSlotCap: r.pick([2, 4, 16]),
          gapSplitK: r.int(1, 3),
        }),
      );
      // Start with existing points, a confirmed gap, and an uncached region.
      engine.put(id, batch([ms(-6), ms(-2)], [12, 34]));
      engine.put(id, batch([ms(5)], [55]));
      reset();
      const reader = new Reader(interval, times);
      reader.remember(whole, engine.get(id, whole)); // Engine.get is cacheOnly (§4.6).
      const log: string[] = [];
      const seen = new Set<string>();
      for (let step = 0; step < 80; step++) {
        const a = r.int(-8, 8);
        const b = r.int(-8, 8);
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const range = { start: ms(lo), end: ms(hi) };
        // Guarantee each operation family, then use random interleavings.
        const kind = step < 4 ? ([0, 3, 4, 5][step] as number) : r.int(0, 5);
        const version = r.pick(["v1", "v2"]);
        seen.add(
          kind <= 2
            ? "put"
            : kind === 3
              ? "invalidate"
              : kind === 4
                ? "watermark"
                : "clear",
        );
        log.push(
          `${step}: kind=${kind} range=${JSON.stringify(range)} version=${version}`,
        );
        events.length = 0;
        if (kind <= 2) {
          const chosen = times.filter(
            (t) => range.start <= t && t <= range.end && r.int(0, 2) !== 0,
          );
          // The first mutation definitely changes a value the reader holds.
          const timestamps = step === 0 ? [ms(-6)] : chosen;
          const values = timestamps.map(() =>
            r.pick([r.int(-100, 100), Number.NaN, -0]),
          );
          if (step === 0) values[0] = 999;
          const meta =
            step === 0 || r.int(0, 2) === 0
              ? { version }
              : { finalizedUntil: ms(r.int(-8, 9)) };
          engine.put(
            id,
            batch(timestamps, values, meta),
            kind === 0 ? undefined : { range },
          );
        } else if (kind === 3) {
          // Arbitrary consumer ranges snap outward; stay inside the reader's grid.
          engine.invalidate(id, {
            start: range.start + 0.25,
            end: range.end + 0.25,
          });
        } else if (kind === 4)
          engine.setFinalizedUntil(id, ms(r.int(-9, 9)) + 0.25);
        else engine.clear(id);

        expect(events.length, log.join("\n")).toBeLessThanOrEqual(1);
        for (const event of events) {
          normalized(event, interval);
          expect(event.cacheId).toBe(id);
          if (event.cleared) reader.remember(whole, engine.get(id, whole));
          else {
            for (const changed of [...event.written, ...event.removed]) {
              // Re-read only ranges named by the notification, fetching nothing.
              reader.remember(changed, engine.get(id, changed));
            }
          }
        }
        const query = {
          start: ms(r.int(-7, 0)) + 0.25,
          end: ms(r.int(1, 7)) - 0.25,
        };
        for (const shown of [whole, range, query]) {
          expect(
            reader.result(shown),
            `seed=${seed}\n${log.join("\n")}`,
          ).toEqual(engine.get(id, shown));
        }
      }
      expect([...seen].sort()).toEqual([
        "clear",
        "invalidate",
        "put",
        "watermark",
      ]);
    },
  );
});
