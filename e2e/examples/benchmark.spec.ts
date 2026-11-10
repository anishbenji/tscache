import { expect, type Page, test } from "@playwright/test";
import type {
  freshWorkers,
  Row,
  RunResult,
} from "../../examples/benchmark/src/report";
import { NEW_BARS, TABS, views } from "../../examples/benchmark/src/workload";
import { appUrl } from "./apps";
import { control } from "./support";

// examples/benchmark: the workload once per mode, and only the counts it
// makes the backend serve, which the workload fixes; no timing is checked
// (docs/testing.md). The backend's counters are deltas of each mode's run.

test.use({ baseURL: appUrl("benchmark") });
test.describe.configure({ mode: "serial" });

interface Results {
  rows: Row[];
  runs: RunResult[];
  workers: ReturnType<typeof freshWorkers>;
}

/** How long the page may take to run the workload; a hang fails here. */
const RUN_TIMEOUT = 60_000;

/** Opens the benchmark with `query`, and returns its results once done. */
async function runBenchmark(page: Page, query: string): Promise<Results> {
  await page.goto(`/?${query}&autorun=1`);
  await expect(page.getByTestId("status")).toHaveText("done", {
    timeout: RUN_TIMEOUT,
  });
  return JSON.parse(
    (await page.getByTestId("results-json").textContent()) ?? "{}",
  ) as Results;
}

/** The views of one tab's workload, and of the three tabs of phase two. */
const VIEWS = views(0).length;

test("each mode makes the requests its caching allows, tscache the fewest", async ({
  page,
}) => {
  test.setTimeout(RUN_TIMEOUT + 30_000);
  // One run per mode at the lowest latency: the counts do not depend on it.
  const results = await runBenchmark(page, "runs=1&latency=50");
  const run = (mode: RunResult["mode"]) => {
    const found = results.runs.find((r) => r.mode === mode);
    if (found === undefined) throw new Error(`no run of ${mode}`);
    return found;
  };
  const total = (r: RunResult) => r.one.requests + r.three.requests;
  const none = run("none");
  const memo = run("memo");
  const tanstack = run("tanstack");
  const tscache = run("tscache");

  // No cache fetches every view of every tab.
  expect(none.one.requests).toBe(VIEWS);
  expect(none.three.requests).toBe(TABS * VIEWS);
  // The exact-key caches skip only the views they saw before in the same
  // tab: zooming back in and returning to the newest screen.
  expect(memo.one.requests).toBe(VIEWS - 2);
  expect(memo.three.requests).toBe(TABS * (VIEWS - 2));
  expect(tanstack.one).toEqual(memo.one);
  expect(tanstack.three).toEqual(memo.three);

  expect(total(tscache)).toBeLessThanOrEqual(total(memo));
  expect(total(memo)).toBeLessThanOrEqual(total(tanstack));
  expect(total(tanstack)).toBeLessThanOrEqual(total(none));

  // tscache in three tabs is one tab plus only the newest bars: one
  // request, for the bars the market added, with a flank bar either side
  // at most, however the three tabs' reads met in the shared worker.
  expect(tscache.three.requests).toBe(1);
  expect(tscache.three.bars).toBeGreaterThanOrEqual(NEW_BARS);
  expect(tscache.three.bars).toBeLessThanOrEqual(NEW_BARS + 2);
  // Phase one needs no more requests than the exact-key caches, and fewer
  // bars: the zoomed-out view fetches only what the cache lacks.
  expect(tscache.one.requests).toBeLessThanOrEqual(memo.one.requests);
  expect(tscache.one.bars).toBeLessThan(memo.one.bars);

  // Every view of every tab was drawn.
  for (const r of results.runs) {
    expect(r.chartMs).toHaveLength(VIEWS * (1 + TABS));
    expect(r.requested).toHaveLength(VIEWS * (1 + TABS));
  }
  // Views answered without a request: in the per-tab modes each request is
  // one view's own, so the rest are the views without one. tscache's tabs
  // may join one request, which leaves at most the views it did not make.
  const hits = (r: RunResult) => r.requested.filter((asked) => !asked).length;
  const views = VIEWS * (1 + TABS);
  for (const r of [none, memo, tanstack])
    expect(hits(r)).toBe(views - total(r));
  expect(hits(tscache)).toBeLessThanOrEqual(views - total(tscache));
  expect(hits(tscache)).toBeGreaterThanOrEqual(
    views - total(tscache) - (TABS - 1),
  );
  // The table has a row per mode, each from a run whose counts held.
  expect(results.rows.map((row) => row.mode)).toEqual([
    "none",
    "memo",
    "tanstack",
    "tscache",
  ]);
  for (const row of results.rows) expect(row.stable).toBe(true);
  expect(results.workers).toEqual({ runs: 1, workers: 1, fresh: true });
});

test("every tscache run starts a SharedWorker of its own", async ({ page }) => {
  test.setTimeout(RUN_TIMEOUT + 30_000);
  // Two runs, back to back: the first run's worker outlives its last tab
  // (extendedLifetime), so a second run on the same URL would inherit it.
  const { workers, runs } = await runBenchmark(
    page,
    "runs=2&latency=50&modes=tscache",
  );
  expect(runs.map((r) => r.mode)).toEqual(["tscache", "tscache"]);
  expect(workers).toEqual({ runs: 2, workers: 2, fresh: true });
  await expect(page.getByTestId("workers")).toHaveText(
    "A new SharedWorker for each tscache run: 2 runs, 2 workers.",
  );
});

for (const mode of ["none", "memo", "tanstack", "tscache"] as const) {
  test(`a failed fetch fails the ${mode} run instead of counting it`, async ({
    page,
  }) => {
    test.setTimeout(RUN_TIMEOUT + 30_000);
    await page.goto(`/?runs=1&latency=50&modes=${mode}`);
    // The preview has fetched; every series request from here on fails.
    await expect(page.getByTestId("status")).toHaveText("ready");
    await control(page, { failNext: 100 });
    try {
      await page.getByRole("button", { name: "Run the benchmark" }).click();
      await expect(page.getByTestId("status")).toHaveText(/^failed: /, {
        timeout: RUN_TIMEOUT,
      });
      await expect(page.getByTestId("status")).toContainText(
        mode === "tscache" ? "fetch-failed" : "the backend answered 500",
      );
      // No table: a failed run is not a result.
      await expect(page.locator("#results tbody tr")).toHaveCount(0);
    } finally {
      await control(page, { failNext: 0 });
    }
  });
}

test("a failed rerun leaves no results to copy from the run before", async ({
  page,
}) => {
  test.setTimeout(2 * RUN_TIMEOUT + 30_000);
  const status = page.getByTestId("status");
  const copy = page.getByRole("button", { name: "Copy as Markdown" });
  await page.goto("/?runs=1&latency=50&modes=memo");
  await expect(status).toHaveText("ready");
  const run = page.getByRole("button", { name: "Run the benchmark" });
  await run.click();
  await expect(status).toHaveText("done", { timeout: RUN_TIMEOUT });
  await expect(page.locator("#results tbody tr")).toHaveCount(1);
  await expect(copy).toBeEnabled();

  await control(page, { failNext: 100 });
  try {
    await run.click();
    await expect(status).toHaveText(/^failed: /, { timeout: RUN_TIMEOUT });
    // The run before's table, its results and Copy are gone with it.
    await expect(page.locator("#results tbody tr")).toHaveCount(0);
    await expect(page.getByTestId("results-json")).toHaveText("");
    await expect(page.getByTestId("conditions")).not.toContainText(
      "ms per page",
    );
    await expect(copy).toBeDisabled();
  } finally {
    await control(page, { failNext: 0 });
  }
});
