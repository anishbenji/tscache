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

/**
 * The page's fetches since the first `since`, once one of them is a
 * history read; a fetch of the forming bar may come first.
 */
async function waitHistory(page: Page, since: number): Promise<FetchNotice[]> {
  await expect
    .poll(
      async () => (await notices(page)).slice(since).filter(isHistory).length,
    )
    .toBeGreaterThan(0);
  return (await notices(page)).slice(since);
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
    const loaded = await waitHistory(page, before);
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

/** The bar count the page shows. */
async function barCount(page: Page): Promise<number> {
  const text = (await page.getByTestId("summary").textContent()) ?? "";
  return Number(/^(\d+) bars/.exec(text)?.[1] ?? Number.NaN);
}

/** The start of the range on screen, in ms (shown as `MM-DD HH:MM`). */
async function showingStart(page: Page): Promise<number> {
  const text = (await page.getByTestId("showing").textContent()) ?? "";
  const start = text.split(" – ")[0] ?? "";
  const year = new Date().getUTCFullYear();
  return Date.parse(`${year}-${start.replace(" ", "T")}:00Z`);
}

test("a dataset version pushed with a bar refills the history it cleared (R1-1)", async ({
  context,
}) => {
  const page = await openTab(context);
  await waitNotices(page, 1);
  const fetched = (await notices(page)).length;
  expect(await barCount(page)).toBeGreaterThan(600);
  await control(page, { bumpVersion: true });
  // The next pushed batch carries the new version and clears the cache;
  // the page reads its range again rather than from the cache alone.
  await waitHistory(page, fetched);
  await expect.poll(() => barCount(page)).toBeGreaterThan(600);
});

test("switching the chart library after scrolling keeps the time on screen (R1-2)", async ({
  context,
}) => {
  const page = await openTab(context);
  await waitNotices(page, 1);
  const opening = await showingStart(page);
  const before = (await notices(page)).length;
  await drag(page, "back");
  await waitHistory(page, before);
  await expect.poll(() => showingStart(page)).toBeLessThan(opening - HOUR);
  const scrolled = await showingStart(page);
  await page.selectOption("#chart-kind", "uplot");
  await expect(page.locator("#chart .u-over")).toBeVisible();
  // Past a pushed bar's redraw too, the new chart stays where the old was.
  await nextDraw(page);
  expect(Math.abs((await showingStart(page)) - scrolled)).toBeLessThanOrEqual(
    2 * MINUTE,
  );
});

test("a failed history fetch shows as missing, and Retry fetches it (R1-3)", async ({
  context,
}) => {
  const page = await openTab(context);
  await waitNotices(page, 1);
  await expect(page.getByTestId("missing")).toHaveText("nothing missing");
  await control(page, { failNext: 2 });
  await drag(page, "back");
  await expect(page.getByTestId("missing")).toContainText("fetch failed");
  await control(page, { failNext: 0 });
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByTestId("missing")).toHaveText("nothing missing");
  await expect(page.getByRole("button", { name: "Retry" })).toBeHidden();
});

/** How many pixels of the chart's canvases have a candle's colour. */
function candlePixels(page: Page): Promise<number> {
  return page.evaluate(() => {
    // Opaque RGBA pixels read as little-endian words: 0xAABBGGRR.
    const candles = new Set([0xffd6782a, 0xff3468eb]);
    const canvases =
      document.querySelectorAll<HTMLCanvasElement>("#chart canvas");
    return [...canvases]
      .map((canvas) => {
        const context = canvas.getContext("2d");
        const image = context?.getImageData(0, 0, canvas.width, canvas.height);
        const pixels = new Uint32Array(
          image?.data.buffer ?? new ArrayBuffer(0),
        );
        return pixels.filter((pixel) => candles.has(pixel)).length;
      })
      .reduce((sum, n) => sum + n, 0);
  });
}

test("an answer without bars clears the uPlot chart (R2-1)", async ({
  context,
}) => {
  const page = await openTab(context, "/?chart=uplot");
  await waitNotices(page, 1);
  // Two screens back, so the range read holds no bar the feed pushes.
  for (let i = 0; i < 2; i++) {
    const before = (await notices(page)).length;
    await drag(page, "back");
    await waitHistory(page, before);
    await page.waitForTimeout(500);
  }
  await expect.poll(() => candlePixels(page)).toBeGreaterThan(0);
  await control(page, { failNext: 1000 });
  // The next pushed batch clears the cache, and the refill fails.
  await control(page, { bumpVersion: true });
  await expect(page.getByTestId("summary")).toContainText("0 bars");
  await expect.poll(() => candlePixels(page)).toBe(0);
  await control(page, { failNext: 0 });
});

test("a tab signed out with the others recovers when one signs in (R2-2)", async ({
  context,
}) => {
  const a = await openTab(context);
  const b = await openTab(context);
  // A refresh token the backend refuses: the next refresh ends the session.
  await a.evaluate(() => {
    const key = "tscache-reference:tokens";
    const tokens = JSON.parse(localStorage.getItem(key) ?? "{}");
    localStorage.setItem(key, JSON.stringify({ ...tokens, refresh: "rt-x" }));
  });
  await control(a, { expireAccess: true });
  await drag(a, "back");
  await expect(a.getByTestId("auth")).toHaveText("signed out");
  await expect(b.getByTestId("auth")).toHaveText("signed out");
  await a.getByRole("button", { name: "Sign in again" }).click();
  await expect(a.getByTestId("auth")).toHaveText("signed in");
  await expect(b.getByTestId("auth")).toHaveText("signed in");
  await expect(b.getByRole("button", { name: "Sign in again" })).toBeHidden();
});

test("bars after a gap in the stream are read through it while the chart follows (R3-1)", async ({
  context,
}) => {
  const page = await context.newPage();
  // The page's clock three minutes behind the backend's: its first read
  // ends three bars before the first pushed bar, as after a stream outage.
  await page.clock.setSystemTime(Date.now() - 3 * MINUTE);
  await recordNotices(page);
  await page.goto("/");
  await expect(page.getByTestId("connection")).toHaveText("live");
  await expect(page.getByTestId("summary")).toContainText("bars");
  const fetched = (await notices(page)).length;
  const opened = await barCount(page);
  // The fetch flank reaches one bar past the read, so two remain to fill.
  await expect.poll(() => barCount(page)).toBeGreaterThanOrEqual(opened + 2);
  expect((await notices(page)).length).toBeGreaterThan(fetched);
  // Then the chart follows the stream again.
  await nextDraw(page);
});
