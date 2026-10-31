// The Lightweight Charts view against stand-ins for the library's series,
// which keep their bars as the library documents setData() and update():
// setData replaces every bar; update replaces the last bar when its time
// is the same, adds one after it, and refuses an earlier time. Each test
// checks what each series holds after the draw, not only which call it got.

import type { GetResult } from "tscache";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLightweightChart } from "../src/chart/lightweight";
import type { ChartView } from "../src/chart/view";
import { answer, type Bar, HISTORY, MINUTE, T0 } from "./answers";

const library = vi.hoisted(() => {
  interface Timed {
    time: number;
  }
  class Series {
    bars: Timed[] = [];
    calls: ("setData" | "update")[] = [];
    setData(bars: Timed[]): void {
      this.calls.push("setData");
      this.bars = [...bars];
    }
    update(bar: Timed): void {
      this.calls.push("update");
      const last = this.bars.at(-1);
      if (last !== undefined && bar.time < last.time) {
        throw new Error("update() before the last bar");
      }
      if (last?.time === bar.time) this.bars[this.bars.length - 1] = bar;
      else this.bars.push(bar);
    }
  }
  return { Series, series: [] as Series[] };
});

vi.mock("lightweight-charts", () => ({
  CandlestickSeries: "candlestick",
  HistogramSeries: "histogram",
  createChart: () => ({
    addSeries() {
      const series = new library.Series();
      library.series.push(series);
      return series;
    },
    panes: () => [],
    timeScale: () => ({
      subscribeVisibleLogicalRangeChange() {},
      unsubscribeVisibleLogicalRangeChange() {},
      subscribeSizeChange() {},
      unsubscribeSizeChange() {},
      setVisibleLogicalRange() {},
    }),
    remove() {},
  }),
}));

/** The view's colours for a rising and a falling bar's volume. */
const UP = "#2a78d6";
const DOWN = "#eb6834";

/** The bars each series must hold for `result`, worked out here. */
function expected({ timestamps, fields }: GetResult) {
  const { open, high, low, close, volume } = fields;
  const at = (column: ArrayLike<number> | undefined, i: number) =>
    column?.[i] ?? Number.NaN;
  return {
    candles: Array.from(timestamps, (t, i) => ({
      time: t / 1000,
      open: at(open, i),
      high: at(high, i),
      low: at(low, i),
      close: at(close, i),
    })),
    volumes: Array.from(timestamps, (t, i) => ({
      time: t / 1000,
      value: at(volume, i),
      color: at(close, i) >= at(open, i) ? UP : DOWN,
    })),
  };
}

let view: ChartView;

beforeEach(() => {
  library.series.length = 0;
  const element = {
    addEventListener() {},
    removeEventListener() {},
    dataset: {},
  } as unknown as HTMLElement;
  view = createLightweightChart(element, {
    interval: MINUTE,
    opening: { start: T0, end: T0 + 10 * MINUTE },
  });
});

function series() {
  const [candles, volume] = library.series;
  if (candles === undefined || volume === undefined) {
    throw new Error("the view added no series");
  }
  return { candles, volume };
}

/** Draws `first`, then `next`, and returns the calls `next` made. */
function drawAfter(first: GetResult, next: GetResult) {
  view.draw(first);
  const { candles, volume } = series();
  candles.calls = [];
  volume.calls = [];
  view.draw(next);
  return { candles: candles.calls, volume: volume.calls };
}

function expectHolds(result: GetResult): void {
  const { candles, volumes } = expected(result);
  expect(series().candles.bars).toEqual(candles);
  expect(series().volume.bars).toEqual(volumes);
}

describe("the Lightweight Charts view", () => {
  it("draws the first answer with setData", () => {
    const first = answer(HISTORY);
    view.draw(first);
    expect(series().candles.calls).toEqual(["setData"]);
    expect(series().volume.calls).toEqual(["setData"]);
    expectHolds(first);
  });

  it("adds an appended bar to both series with update()", () => {
    const next = answer([...HISTORY, [14, 15, 13, 13.5, 7]]);
    const calls = drawAfter(answer(HISTORY), next);
    expect(calls).toEqual({ candles: ["update"], volume: ["update"] });
    expectHolds(next);
  });

  it("replaces the forming bar in both series with update()", () => {
    // Its close falls below its open, so its volume changes colour too.
    const next = answer([...HISTORY.slice(0, 3), [13, 16, 11, 12, 900]]);
    const calls = drawAfter(answer(HISTORY), next);
    expect(calls).toEqual({ candles: ["update"], volume: ["update"] });
    expectHolds(next);
  });

  it("replaces the forming bar and adds the bars after it, in order", () => {
    const next = answer([
      ...HISTORY.slice(0, 3),
      [13, 15, 12, 14.2],
      [14.2, 15, 14, 14.8],
      [14.8, 16, 14.5, 14.1],
    ]);
    const calls = drawAfter(answer(HISTORY), next);
    const updates = ["update", "update", "update"];
    expect(calls).toEqual({ candles: updates, volume: updates });
    expectHolds(next);
  });

  it("redraws every bar with setData when an earlier bar was corrected", () => {
    const corrected = HISTORY.map((bar): Bar => [...bar]);
    corrected[1] = [11, 13, 10, 10.5, 1];
    const next = answer([...corrected, [14, 15, 13, 14]]);
    const calls = drawAfter(answer(HISTORY), next);
    expect(calls).toEqual({ candles: ["setData"], volume: ["setData"] });
    expectHolds(next);
  });

  it("redraws every bar with setData when the range moved", () => {
    const next = answer([...HISTORY.slice(1), [14, 15, 13, 14]], 1);
    const calls = drawAfter(answer(HISTORY), next);
    expect(calls).toEqual({ candles: ["setData"], volume: ["setData"] });
    expectHolds(next);
  });

  it("keeps both series right across a run of live answers", () => {
    let bars: Bar[] = [...HISTORY];
    view.draw(answer(bars));
    for (let tick = 0; tick < 6; tick++) {
      const last = bars.at(-1) ?? [10, 10, 10, 10];
      const close = (last[3] ?? 10) + (tick % 2 === 0 ? 0.5 : -0.3);
      // Even ticks move the forming bar; odd ones close it and open the next.
      bars =
        tick % 2 === 0
          ? [...bars.slice(0, -1), [last[0], last[1], last[2], close, 200]]
          : [...bars, [close, close + 1, close - 1, close]];
      view.draw(answer(bars));
      expectHolds(answer(bars));
    }
    expect(series().candles.calls.filter((c) => c === "setData")).toEqual([
      "setData",
    ]);
  });
});
