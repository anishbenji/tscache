import { describe, expect, it } from "vitest";
import {
  freshWorkers,
  HEADERS,
  HIT_RATIO_NOTE,
  markdown,
  median,
  quantile,
  type ReadView,
  type RunResult,
  reportedPages,
  requestedViews,
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
    requested: [true, false, true],
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
      hits: 1,
      views: 3,
      chartP50: 21,
      chartP95: 31,
      // The view without a request, and the two with one.
      hitP50: 21,
      missP50: 11,
      firstViewMs: 11,
      coldFirstViewMs: 10,
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

  it("flags a mode whose views without a request varied between runs", () => {
    const other = { ...run("memo", 1, 7), requested: [true, true, true] };
    const [row] = rows([run("memo", 0, 7), other], ["memo"]);
    expect(row?.stable).toBe(false);
  });

  it("leaves out a p50 no view of any run gives", () => {
    const all = { ...run("none", 0, 3), requested: [true, true, true] };
    const [row] = rows([all], ["none"]);
    expect(row?.hits).toBe(0);
    expect(row?.hitP50).toBeNaN();
    expect(row?.missP50).toBe(20);
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
    expect(lines[5]).toMatch(
      /^\| tscache \| 3 \(3 \+ 0\) \| 1 of 3 \|.*0\.33× requests/,
    );
    expect(lines.at(-1)).toBe(HIT_RATIO_NOTE);
  });

  it("prints a p50 that no view gives as a dash", () => {
    const all = { ...run("none", 0, 3), requested: [true, true, true] };
    const text = markdown(
      { latencyMs: 50, runs: 1, browser: "Chromium 140" },
      rows([all], ["none"]),
    );
    expect(text).toContain("| – · 20 ms |");
  });
});

describe("requestedViews", () => {
  const view = (askedAt: number, answeredAt: number): ReadView => ({
    cacheId: "c",
    range: { start: 100, end: 200 },
    askedAt,
    answeredAt,
  });
  const report = (endedAt: number, over = { start: 150, end: 250 }) => ({
    cacheId: "c",
    range: over,
    pages: 1,
    endedAt,
    ok: true,
  });

  it("counts a fetch of the view's cache that ended in flight and touched its range", () => {
    expect(requestedViews([view(10, 20)], [report(15)])).toEqual([true]);
    // Ended before the read began, or after it answered.
    expect(requestedViews([view(10, 20)], [report(5), report(25)])).toEqual([
      false,
    ]);
    // Another cache's, a range beside the view's, or a failed fetch.
    expect(
      requestedViews(
        [view(10, 20)],
        [
          { ...report(15), cacheId: "d" },
          report(15, { start: 201, end: 300 }),
          { ...report(15), ok: false },
        ],
      ),
    ).toEqual([false]);
  });
});

describe("reportedPages", () => {
  it("sums the pages of the given caches' fetches that returned data", () => {
    const report = (cacheId: string, pages: number, ok = true) => ({
      cacheId,
      range: { start: 0, end: 1 },
      pages,
      endedAt: 0,
      ok,
    });
    expect(
      reportedPages(
        [report("a", 2), report("b", 3), report("a", 1), report("a", 5, false)],
        new Set(["a"]),
      ),
    ).toBe(3);
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
