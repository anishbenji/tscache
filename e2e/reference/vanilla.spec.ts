import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import type { FetchNotice } from "../../examples/mock-backend/src/notices";
import { appUrl } from "../examples/apps";
import {
  control,
  notices,
  recordNotices,
  span,
  stats,
  waitNotices,
} from "../examples/support";

// reference/vanilla: the live chart in several tabs of one SharedWorker.
// One tab holds the live feed and every tab draws its bars without a
// fetch; scrolling fetches only history the cache lacks, with either chart
// library; an expired token is refreshed once across tabs; and the
// server-rendered page starts the cache from the server's read.

test.use({ baseURL: appUrl("reference-vanilla") });
test.describe.configure({ mode: "serial" });

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

async function openTab(context: BrowserContext, path = "/"): Promise<Page> {
  const page = await context.newPage();
  await recordNotices(page);
  await page.goto(path);
  await expect(page.getByTestId("connection")).toHaveText("live");
  await expect(page.getByTestId("summary")).toContainText("bars");
  return page;
}

/** Waits until the page draws again: a pushed bar, or another answer. */
async function nextDraw(page: Page): Promise<void> {
  const drawn = page.getByTestId("drawn");
  const before = (await drawn.textContent()) ?? "";
  await expect(drawn).not.toHaveText(before, { timeout: 5000 });
}

/**
 * Drags the chart by most of its width: right goes back in time, left
 * forward.
 */
async function drag(page: Page, toward: "back" | "forward"): Promise<void> {
  const box = await page.locator("#chart").boundingBox();
  if (box === null) throw new Error("no chart");
  const y = box.y + box.height / 3;
  const [from, to] = toward === "back" ? [0.2, 0.9] : [0.9, 0.2];
  await page.mouse.move(box.x + box.width * from, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to, y, { steps: 20 });
  await page.mouse.up();
}

function isHistory(notice: FetchNotice): boolean {
  return span(notice) > HOUR;
}

test("one tab holds the live feed, and every tab draws its bars without a fetch", async ({
  context,
}) => {
  const a = await openTab(context);
  const b = await openTab(context);
  await expect(b.getByTestId("mode")).toHaveText("shared");
  expect((await stats(a)).streams).toBe(1);

  const fetched = (await notices(b)).length;
  await nextDraw(a);
  await nextDraw(b);
  await nextDraw(b);
  expect((await notices(b)).length).toBe(fetched);

  // The holder leaves; the other tab takes the feed over.
  await a.close();
  await expect.poll(async () => (await stats(b)).streams).toBe(1);
  await nextDraw(b);
  await nextDraw(b);
});

for (const chart of ["lightweight", "uplot"] as const) {
  test(`scrolling back fetches only the history the cache lacks (${chart})`, async ({
    context,
  }) => {
    const page = await openTab(context, `/?chart=${chart}`);
    await waitNotices(page, 1);
    const before = (await notices(page)).length;
    await drag(page, "back");
    const after = await waitNotices(page, before + 1);
    const loaded = after.slice(before);
    expect(loaded.filter(isHistory).length).toBeGreaterThanOrEqual(1);
    const opening = (await notices(page))[0];
    if (opening === undefined) throw new Error("no opening fetch");
    // The history read lies before what the opening fetched.
    for (const notice of loaded.filter(isHistory)) {
      expect(notice.range.start).toBeLessThan(opening.range.start);
      expect(notice.range.end).toBeLessThanOrEqual(opening.range.start);
    }
    // Back where it was: the history is answered from the cache.
    await page.waitForTimeout(1000);
    const settled = (await notices(page)).length;
    await drag(page, "forward");
    await page.waitForTimeout(1500);
    const back = (await notices(page)).slice(settled);
    expect(back.filter(isHistory)).toEqual([]);
    await page.close();
  });
}

test("an expired token is refreshed once and every tab reads again", async ({
  context,
}) => {
  test.setTimeout(60_000);
  const a = await openTab(context);
  const b = await openTab(context);
  const before = await stats(a);
  await control(a, { expireAccess: true });
  // The next fetch is refused: scrolling back asks for history.
  await drag(a, "back");
  await expect
    .poll(async () => (await stats(a)).refused)
    .toBeGreaterThan(before.refused);
  await expect
    .poll(async () => (await stats(a)).refreshes)
    .toBe(before.refreshes + 1);
  await expect(a.getByTestId("auth")).toHaveText("signed in");
  await expect(b.getByTestId("auth")).toHaveText("signed in");
  const after = await stats(a);
  expect(after.reused).toBe(before.reused);
  expect(after.refreshes).toBe(before.refreshes + 1);
});

test("the server-rendered page shows the server's read and fetches only the forming bar", async ({
  context,
}) => {
  const page = await context.newPage();
  await recordNotices(page);
  const response = await page.goto("/ssr");
  const html = (await response?.text()) ?? "";
  // The server's markup carries the answer, and its read for the cache.
  expect(html).toMatch(/data-testid="summary">\d+ bars, last close/);
  expect(html).toContain('id="tscache-read"');
  await expect(page.getByTestId("connection")).toHaveText("live");
  await expect(page.locator("#chart canvas").first()).toBeVisible();
  await page.waitForTimeout(1000);
  for (const notice of await notices(page)) {
    expect(span(notice)).toBeLessThanOrEqual(2 * MINUTE);
  }
});

test("switching the chart library keeps what is drawn without fetching", async ({
  context,
}) => {
  const page = await openTab(context);
  const fetched = (await notices(page)).length;
  await page.selectOption("#chart-kind", "uplot");
  await expect(page.locator("#chart .u-over")).toBeVisible();
  await expect(page).toHaveURL(/chart=uplot/);
  await page.selectOption("#chart-kind", "lightweight");
  await expect(page.locator("#chart .u-over")).toHaveCount(0);
  await expect(page.locator("#chart canvas").first()).toBeVisible();
  expect((await notices(page)).length).toBe(fetched);
});
