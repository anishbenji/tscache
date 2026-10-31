// The uPlot view against a stand-in for uPlot: whatever changed, a draw
// hands uPlot every bar of the answer, as the cache's own arrays, with the
// time first and the columns in the order the series are declared.

import type { GetResult } from "tscache";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createUplotChart } from "../src/chart/uplot";
import type { ChartView } from "../src/chart/view";
import { answer, type Bar, HISTORY, MINUTE, T0 } from "./answers";

const library = vi.hoisted(() => {
  class Plot {
    static paths = {};
    static pxRatio = 1;
    static tzDate = (date: Date) => date;
    /** The data of each setData() call, and whether it reset the scales. */
    sets: { data: ArrayLike<number>[]; reset: boolean | undefined }[] = [];
    scales = { x: {} };
    constructor() {
      library.plots.push(this);
    }
    batch(run: () => void): void {
      run();
    }
    setData(data: ArrayLike<number>[], reset?: boolean): void {
      this.sets.push({ data, reset });
    }
    setScale(): void {}
    setSize(): void {}
    destroy(): void {}
  }
  return { Plot, plots: [] as Plot[] };
});

vi.mock("uplot", () => ({ default: library.Plot }));
vi.mock("uplot/dist/uPlot.min.css", () => ({}));
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe(): void {}
    disconnect(): void {}
  },
);

let view: ChartView;

beforeEach(() => {
  library.plots.length = 0;
  const element = { clientWidth: 800, dataset: {} } as unknown as HTMLElement;
  view = createUplotChart(element, {
    interval: MINUTE,
    opening: { start: T0, end: T0 + 10 * MINUTE },
  });
});

/** The data of the last setData(), checked to be all of `result`. */
function expectAll(result: GetResult): void {
  const set = library.plots[0]?.sets.at(-1);
  const { timestamps, fields } = result;
  const columns = ["open", "high", "low", "close", "volume"];
  expect(set?.reset).toBe(false);
  expect(set?.data).toHaveLength(1 + columns.length);
  expect(set?.data[0]).toBe(timestamps);
  columns.forEach((name, i) => {
    expect(set?.data[i + 1]).toBe(fields[name]);
  });
}

describe("the uPlot view", () => {
  const corrected = HISTORY.map((bar): Bar => [...bar]);
  corrected[1] = [11, 13, 10, 10.5];

  it.each<[string, GetResult]>([
    ["an appended bar", answer([...HISTORY, [14, 15, 13, 14]])],
    ["the forming bar", answer([...HISTORY.slice(0, 3), [13, 16, 11, 12]])],
    ["an earlier correction", answer([...corrected, [14, 15, 13, 14]])],
    ["a moved range", answer([...HISTORY.slice(1), [14, 15, 13, 14]], 1)],
  ])("hands uPlot every bar for %s", (_, next) => {
    const first = answer(HISTORY);
    view.draw(first);
    expectAll(first);
    view.draw(next);
    expect(library.plots[0]?.sets).toHaveLength(2);
    expectAll(next);
  });
});
