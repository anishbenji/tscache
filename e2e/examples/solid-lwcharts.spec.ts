import { expect, type Page, test } from "@playwright/test";
import type { FetchNotice } from "../../examples/mock-backend/src/notices";
import { appUrl } from "./apps";
import { notices, recordNotices, span, waitNotices } from "./support";

// examples/solid-lwcharts: OHLCV scroll-back over weekday sessions. Bars
// exist 13:30–20:00 UTC on weekdays, so a fortnight of 30-minute slots
// (672) holds 130 bars and 542 slots the cache knows are empty.

test.use({ baseURL: appUrl("solid-lwcharts") });
test.describe.configure({ mode: "serial" });

const INTERVAL = 30 * 60_000;
const FORTNIGHT = 14 * 24 * 3_600_000;
const SLOTS = FORTNIGHT / INTERVAL;
const BARS = 130;

async function value(page: Page, name: string): Promise<number> {
  return Number(await page.getByTestId(name).textContent());
}

interface Counts {
  bars: number;
  /** Bars plus empty slots known: every covered slot, and the bar forming. */
  slots: number;
}

async function counts(page: Page): Promise<Counts> {
  const bars = await value(page, "bars");
  return { bars, slots: bars + (await value(page, "empty")) };
}

async function open(page: Page): Promise<void> {
  await recordNotices(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready");
}

async function load(page: Page): Promise<FetchNotice> {
  await open(page);
  const [first] = await waitNotices(page, 1);
  if (!first) throw new Error("no fetch on load");
  return first;
}

/**
 * Waits for the fortnight before `loadedStart` to be drawn, and checks it
 * was the only history fetched since notice `since`: one fetch of exactly
 * that fortnight, which ends at `loadedStart` because the miss is extended
 * by one interval into the coverage it abuts. Any other fetch is of the
 * provisional slot at the right edge, which the cache refetches on every
 * get.
 */
async function expectEarlierFortnight(
  page: Page,
  first: FetchNotice,
  loadedStart: number,
  since: number,
  before: Counts,
): Promise<void> {
  await expect
    .poll(() => value(page, "bars"))
    .toBeGreaterThanOrEqual(before.bars + BARS);
  // A provisional-slot fetch starts one interval before the watermark,
  // which lies at most one interval before the end of the first fetch.
  const tail = first.range.end - 2 * INTERVAL;
  const history = async () =>
    (await notices(page)).slice(since).filter((n) => n.range.start < tail);
  await expect.poll(async () => (await history()).length).toBe(1);
  expect((await history()).map((n) => n.range)).toEqual([
    { start: loadedStart - FORTNIGHT, end: loadedStart },
  ]);
  const all = await notices(page);
  expect(all.every((n) => n.outcome === "ok")).toBe(true);
  await expect(page.getByTestId("fetches")).toHaveText(String(all.length));

  const after = await counts(page);
  // One more bar and slot when a bar started forming meanwhile.
  expect(after.bars - before.bars).toBeLessThanOrEqual(BARS + 1);
  expect(after.slots - before.slots).toBeGreaterThanOrEqual(SLOTS);
  expect(after.slots - before.slots).toBeLessThanOrEqual(SLOTS + 1);
}

test("loads a fortnight and knows its nights and weekends are empty", async ({
  page,
}) => {
  const first = await load(page);
  await expect(page.getByTestId("mode")).toHaveText("shared");
  expect(span(first)).toBeGreaterThanOrEqual(FORTNIGHT);
  expect(span(first)).toBeLessThanOrEqual(FORTNIGHT + INTERVAL);
  const bars = await value(page, "bars");
  const empty = await value(page, "empty");
  expect(bars).toBeGreaterThan(0);
  expect(empty).toBeGreaterThan(0);
  // Every slot of the fortnight is covered, bar or not; the bar forming
  // now, if any, is drawn but not covered.
  expect(bars + empty).toBeGreaterThanOrEqual(SLOTS);
  expect(bars + empty).toBeLessThanOrEqual(SLOTS + 1);
  expect(bars).toBeLessThanOrEqual(BARS + 1);
  await expect(page.getByTestId("fetches")).toHaveText("1");
});

test("each earlier fortnight is fetched alone; the loaded range comes from the cache", async ({
  page,
}) => {
  const first = await load(page);
  const button = page.getByRole("button", {
    name: "Load an earlier fortnight",
  });
  let loadedStart = first.range.start;
  for (let round = 0; round < 2; round++) {
    const since = (await notices(page)).length;
    const before = await counts(page);
    await button.click();
    await expectEarlierFortnight(page, first, loadedStart, since, before);
    loadedStart -= FORTNIGHT;
  }
});

test("dragging the chart to its left edge loads the earlier fortnight once", async ({
  page,
}) => {
  const first = await load(page);
  const before = await counts(page);
  const box = await page.locator(".chart").boundingBox();
  if (!box) throw new Error("the chart is not on screen");
  // 60 bars to the right at 10 px a bar: the view starts about 35 bars in,
  // so it passes the left edge, and the chart reports it at every step.
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 50, y);
  await page.mouse.down();
  await page.mouse.move(box.x + 650, y, { steps: 30 });
  await page.mouse.up();
  await expectEarlierFortnight(page, first, first.range.start, 1, before);
});

test("when the tab hosting the worker crashes, the other tab reconnects and draws again", async ({
  context,
}) => {
  // The first tab to connect creates the SharedWorker, in its own renderer.
  const host = await context.newPage();
  await load(host);
  const survivor = await context.newPage();
  await open(survivor);
  const since = (await notices(survivor)).length;

  const dead = host.waitForEvent("crash");
  const cdp = await context.newCDPSession(host);
  cdp.send("Page.crash").catch(() => {});
  await dead;

  await expect(survivor.locator(".log")).toContainText("worker lost");
  // The new worker starts with an empty cache: the loaded fortnight is
  // fetched again.
  await expect
    .poll(async () =>
      (await notices(survivor)).slice(since).some((n) => span(n) >= FORTNIGHT),
    )
    .toBe(true);
  await expect(survivor.getByTestId("status")).toHaveText("ready");
  await expect(survivor.getByTestId("mode")).toHaveText("shared");
  expect(await value(survivor, "bars")).toBeGreaterThanOrEqual(BARS);
});
