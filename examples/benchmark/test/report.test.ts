import { describe, expect, it } from "vitest";
import {
  freshWorkers,
  HEADERS,
  markdown,
  median,
  quantile,
  type RunResult,
  rows,
} from "../src/report";
import type { Mode } from "../src/workload";

function run(mode: Mode, n: number, requests: number, bytes = 1000): RunResult {
  return {
    mode,
    run: n,
    one: { requests, bars: 10 * requests, bytes },
    three: { requests: 0, bars: 0, bytes: 0 },
    chartMs: [10 + n, 20 + n, 30 + n],
    workloadMs: 100 + n,
    setupMs: n,
    longTasks: { count: n, ms: 50 * n },
  };
}

describe("median and quantile", () => {
  it("take the middle, and the nearest rank", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNaN();
    expect(quantile([5, 1, 4, 2, 3], 0.5)).toBe(3);
    expect(quantile([5, 1, 4, 2, 3], 0.95)).toBe(5);
  });
});

describe("rows", () => {
  it("gives each mode the medians of its runs and its share of no cache's", () => {
    const table = rows(
      [
        run("none", 0, 10, 4000),
        run("tscache", 0, 2, 1000),
        run("none", 1, 10, 4000),
        run("tscache", 1, 2, 1000),
        run("none", 2, 10, 4000),
        run("tscache", 2, 2, 1000),
      ],
      ["none", "memo", "tscache"],
    );
    expect(table.map((row) => row.mode)).toEqual(["none", "tscache"]);
    const [none, tscache] = table;
    expect(none?.vsNone).toEqual({ requests: 1, bytes: 1 });
    expect(tscache).toMatchObject({
      requests: 2,
      bars: 20,
      stable: true,
      chartP50: 21,
      chartP95: 31,
      workloadMs: 101,
      setupMs: 1,
      coldSetupMs: 0,
      vsNone: { requests: 0.2, bytes: 0.25 },
    });
  });

  it("flags a mode whose requests varied between runs", () => {
    const [row] = rows([run("memo", 0, 7), run("memo", 1, 8)], ["memo"]);
    expect(row?.stable).toBe(false);
    expect(row?.vsNone).toBeUndefined();
  });
});

describe("markdown", () => {
  it("prints the conditions above a row per mode", () => {
    const table = rows(
      [run("none", 0, 9), run("tscache", 0, 3)],
      ["none", "tscache"],
    );
    const text = markdown(
      { latencyMs: 300, runs: 1, browser: "Chromium 140" },
      table,
    );
    const lines = text.split("\n");
    expect(lines[0]).toBe(
      "Backend latency 300 ms per page · 1 run per mode, medians shown · Chromium 140",
    );
    expect(lines[2]).toBe(`| ${HEADERS.join(" | ")} |`);
    expect(lines[4]).toMatch(/^\| No cache \| 9 \(9 \+ 0\) \|/);
    expect(lines[5]).toMatch(/^\| tscache \| 3 \(3 \+ 0\) \|.*0\.33× requests/);
  });
});

describe("freshWorkers", () => {
  const report = (run: string, worker: string) => ({
    cacheId: `crypto/BENCH/n-${run}-tscache`,
    worker,
  });

  it("holds when each tscache run had a worker of its own", () => {
    expect(
      freshWorkers([
        report("0", "a"),
        report("0", "a"),
        report("1", "b"),
        { cacheId: "crypto/BENCH", worker: "page" },
      ]),
    ).toEqual({ runs: 2, workers: 2, fresh: true });
  });

  it("fails when a run reused a worker, or one run saw two", () => {
    expect(freshWorkers([report("0", "a"), report("1", "a")]).fresh).toBe(
      false,
    );
    expect(freshWorkers([report("0", "a"), report("0", "b")]).fresh).toBe(
      false,
    );
  });
});
