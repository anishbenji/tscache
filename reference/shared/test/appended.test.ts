import type { GetResult } from "tscache";
import { describe, expect, it } from "vitest";
import { appendedFrom } from "../src/chart/view";

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 9, 30, 12, 0);

type Bar = [open: number, high: number, low: number, close: number];

/** An answer of one-minute bars from T0 + `first` minutes on. */
function answer(bars: readonly Bar[], first = 0): GetResult {
  const column = (k: number) => Float64Array.from(bars, (bar) => bar[k] ?? 0);
  return {
    timestamps: Float64Array.from(bars, (_, i) => T0 + (first + i) * MINUTE),
    fields: {
      open: column(0),
      high: column(1),
      low: column(2),
      close: column(3),
      volume: Float64Array.from(bars, (_, i) => 100 + i),
    },
    coverage: [],
    misses: [],
  };
}

const HISTORY: Bar[] = [
  [10, 12, 9, 11],
  [11, 13, 10, 12],
  [12, 14, 11, 13],
  [13, 15, 12, 14],
];

describe("appendedFrom", () => {
  it("draws only a bar appended after the last one", () => {
    const before = answer(HISTORY);
    const after = answer([...HISTORY, [14, 15, 13, 14.5]]);
    expect(appendedFrom(before, after)).toBe(4);
  });

  it("draws only the forming bar when it is all that changed", () => {
    const before = answer(HISTORY);
    const after = answer([...HISTORY.slice(0, 3), [13, 16, 12, 15.5]]);
    expect(appendedFrom(before, after)).toBe(3);
  });

  it("draws the forming bar and the bars appended after it", () => {
    const before = answer(HISTORY);
    const after = answer([
      ...HISTORY.slice(0, 3),
      [13, 15, 12, 14.2],
      [14.2, 15, 14, 14.8],
      [14.8, 16, 14.5, 15.1],
    ]);
    expect(appendedFrom(before, after)).toBe(3);
  });

  it("draws several appended bars from the first of them", () => {
    const before = answer(HISTORY);
    const after = answer([
      ...HISTORY,
      [14, 15, 13, 14.5],
      [14.5, 16, 14, 15],
      [15, 17, 14.5, 16],
    ]);
    expect(appendedFrom(before, after)).toBe(4);
  });

  it("draws nothing again for the same bars", () => {
    const before = answer(HISTORY);
    expect(appendedFrom(before, answer(HISTORY))).toBe(4);
    expect(appendedFrom(before, before)).toBe(4);
  });

  it("redraws every bar when an earlier bar changed", () => {
    const before = answer(HISTORY);
    const changed = HISTORY.map((bar): Bar => [...bar]);
    changed[1] = [11, 13, 10, 12.5];
    expect(appendedFrom(before, answer([...changed, [14, 15, 13, 14]]))).toBe(
      undefined,
    );
    expect(appendedFrom(before, answer(changed))).toBe(undefined);
  });

  it("redraws every bar when an earlier bar's volume changed", () => {
    const before = answer(HISTORY);
    const after = answer(HISTORY);
    (after.fields.volume as Float64Array)[0] = 1;
    expect(appendedFrom(before, after)).toBe(undefined);
  });

  it("redraws every bar when a gap was filled", () => {
    // Bars at minutes 0, 1, 3 and 4: minute 2 was missing.
    const gappy = answer(HISTORY);
    const timestamps = Float64Array.from([0, 1, 3, 4], (m) => T0 + m * MINUTE);
    const before = { ...gappy, timestamps };
    const after = answer([...HISTORY, [14, 15, 13, 14]]);
    expect(appendedFrom(before, after)).toBe(undefined);
  });

  it("redraws every bar when a gap opened", () => {
    const before = answer(HISTORY);
    const after = answer(HISTORY);
    const timestamps = Float64Array.from([0, 1, 3, 4], (m) => T0 + m * MINUTE);
    expect(appendedFrom(before, { ...after, timestamps })).toBe(undefined);
  });

  it("redraws every bar when the range shifted", () => {
    const before = answer(HISTORY);
    // Moved on by one bar: the first one dropped, one appended.
    expect(
      appendedFrom(before, answer([...HISTORY.slice(1), [14, 15, 13, 14]], 1)),
    ).toBe(undefined);
    // Moved back by one bar: one prepended.
    expect(appendedFrom(before, answer([[9, 11, 8, 10], ...HISTORY], -1))).toBe(
      undefined,
    );
    // Narrowed at its end.
    expect(appendedFrom(before, answer(HISTORY.slice(0, 3)))).toBe(undefined);
  });

  it("redraws every bar after an empty answer or none", () => {
    expect(appendedFrom(undefined, answer(HISTORY))).toBe(undefined);
    expect(appendedFrom(answer([]), answer(HISTORY))).toBe(undefined);
  });

  it("redraws every bar for an answer without bars", () => {
    expect(appendedFrom(answer(HISTORY), answer([]))).toBe(undefined);
  });

  it("takes NaN for the same value as NaN, and for a change otherwise", () => {
    const missing: Bar[] = [
      [10, 12, 9, Number.NaN],
      [Number.NaN, 13, 10, 12],
      ...HISTORY.slice(2),
    ];
    const before = answer(missing);
    expect(appendedFrom(before, answer([...missing, [14, 15, 13, 14]]))).toBe(
      4,
    );
    // An earlier NaN filled in, or a value lost to NaN, is a change.
    expect(appendedFrom(before, answer(HISTORY))).toBe(undefined);
    expect(appendedFrom(answer(HISTORY), before)).toBe(undefined);
    // A forming bar that gains or loses a value is only the forming bar.
    const forming: Bar[] = [...HISTORY.slice(0, 3), [13, 15, 12, Number.NaN]];
    expect(
      appendedFrom(
        before,
        answer([...missing.slice(0, 3), ...forming.slice(3)]),
      ),
    ).toBe(3);
  });

  it("redraws every bar when the history came back under a new version", () => {
    // A new dataset version clears the cache: the next answer holds only
    // the bar pushed with it, and the one after the history refetched.
    const before = answer(HISTORY);
    const cleared = answer([[13, 15, 12, 14]], 3);
    expect(appendedFrom(before, cleared)).toBe(undefined);
    const refilled = answer(
      HISTORY.map(([o, h, l, c]) => [o + 1, h + 1, l + 1, c + 1]),
    );
    expect(appendedFrom(cleared, refilled)).toBe(undefined);
  });

  it("redraws every bar when the answer's fields differ", () => {
    const before = answer(HISTORY);
    const { volume: _, ...fewer } = before.fields;
    expect(appendedFrom({ ...before, fields: fewer }, answer(HISTORY))).toBe(
      undefined,
    );
    expect(appendedFrom(before, { ...before, fields: fewer })).toBe(undefined);
    const renamed = {
      ...fewer,
      turnover: before.fields.volume as Float64Array,
    };
    expect(appendedFrom(before, { ...before, fields: renamed })).toBe(
      undefined,
    );
  });
});
