import { expect, type Page, test } from "@playwright/test";
import { isTradingBar } from "../../examples/mock-backend/src/datasets";
import {
  HYDRATION_ELEMENT,
  type Hydration,
} from "../../examples/mock-backend/src/hydration";
import { appUrl } from "./apps";
import { notices, recordNotices, span, stats, waitNotices } from "./support";

// examples/react-ssr: the server reads the last half-year of daily candles
// with one in-process client shared by every render, and writes the covered
// days into the page; the browser puts them into its cache and fetches only
// what they do not cover. The current day is provisional (the backend's
// watermark), so it is never covered and never seeded.

test.use({ baseURL: appUrl("react-ssr") });
test.describe.configure({ mode: "serial" });

const DAY = 86_400_000;
const HALF_YEAR = 182 * DAY;

async function value(page: Page, name: string): Promise<number> {
  return Number(await page.getByTestId(name).textContent());
}

async function hydrationOf(page: Page): Promise<Hydration> {
  const text = await page.locator(`#${HYDRATION_ELEMENT}`).textContent();
  return JSON.parse(text ?? "null");
}

/** The bars the seeds carry: every bar of the server's answer but a forming one. */
function seededBars({ seeds }: Hydration): number {
  return seeds.reduce(
    (bars, seed) => bars + atob(seed.timestamps).length / 8,
    0,
  );
}

function seededSpan({ seeds }: Hydration): { from: number; until: number } {
  return {
    from: Math.min(...seeds.map((seed) => seed.range.start)),
    until: Math.max(...seeds.map((seed) => seed.range.end)),
  };
}

/** The day the server rendered on, from the page rather than the test's clock. */
function renderDay({ range }: Hydration): number {
  return Math.floor(range.end / DAY) * DAY;
}

/**
 * The day the backend's watermark kept provisional: the one after the last
 * seeded day. It is the render's day, or the next one when midnight UTC
 * passed between the render's clock read and the backend's.
 */
function provisionalDay(hydration: Hydration): number {
  return seededSpan(hydration).until + DAY;
}

/** 1 when the backend had a bar forming that day (a weekday), else 0. */
function formingBars(hydration: Hydration): number {
  return isTradingBar(provisionalDay(hydration), DAY) ? 1 : 0;
}

/**
 * Opens the page and waits until the browser's cache has answered and the
 * chart has drawn it at its final size, so any fetch the first draw could
 * set off has been asked for.
 */
async function open(page: Page): Promise<void> {
  await recordNotices(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready");
  await expect(page.locator(".chart canvas").first()).toBeVisible();
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await expect(page.getByTestId("status")).toHaveText("ready");
}

/**
 * Checks that the only history fetched since notice `since` is the
 * half-year before the first seeded day: one fetch, which ends on that day
 * because the miss is extended by one interval into the coverage it abuts.
 * Any other fetch is of the provisional day, which every get fetches again.
 */
async function expectOlderHalfYear(
  page: Page,
  since: number,
  hydration: Hydration,
  bars: number,
): Promise<void> {
  const { from, until } = seededSpan(hydration);
  await expect.poll(() => value(page, "bars")).toBeGreaterThan(bars + 100);
  await expect(page.getByTestId("status")).toHaveText("ready");
  const history = (await notices(page))
    .slice(since)
    .filter((notice) => notice.range.start < until);
  expect(history.map((notice) => notice.range)).toEqual([
    { start: from - HALF_YEAR, end: from },
  ]);
}

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("the server renders the figures and seeds every covered day", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByTestId("status")).toHaveText("server-rendered");
    const bars = await value(page, "bars");
    expect(bars).toBeGreaterThan(100);
    expect(await value(page, "known-empty")).toBeGreaterThan(0);
    await expect(page.locator(".sessions tbody tr")).toHaveCount(5);
    const hydration = await hydrationOf(page);
    // From the window's first day up to the provisional day, excluded.
    expect(hydration.seeds).toHaveLength(1);
    expect(seededSpan(hydration).from).toBe(
      Math.floor(hydration.range.start / DAY) * DAY,
    );
    expect([renderDay(hydration), renderDay(hydration) + DAY]).toContain(
      provisionalDay(hydration),
    );
    expect(seededBars(hydration) + formingBars(hydration)).toBe(bars);
  });

  test("later renders read the history from the server's cache", async ({
    page,
  }) => {
    // Fills the server's cache, unless an earlier render did.
    await page.goto("/");
    const before = await stats(page);
    await page.goto("/");
    const after = await stats(page);
    // One page at most, for the provisional day. A cold cache would fetch
    // the window in one page too, so server-cached is what tells them apart.
    const pages = (s: typeof after) => s.pages.candles ?? 0;
    expect(pages(after) - pages(before)).toBeLessThanOrEqual(1);
    const bars = await value(page, "bars");
    const forming = formingBars(await hydrationOf(page));
    // Every final bar, but the day that turned final if midnight UTC passed
    // between the two renders.
    const cached = await value(page, "server-cached");
    expect(cached).toBeLessThanOrEqual(bars - forming);
    expect(cached).toBeGreaterThanOrEqual(bars - forming - 1);
  });
});

test("the browser fetches only what the seeds do not cover", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await open(page);
  await expect(page.getByTestId("mode")).toHaveText("shared");
  const hydration = await hydrationOf(page);
  const fetched = await waitNotices(page, 1);
  // The miss abuts the seeds' coverage, so it is extended one interval into
  // it and starts exactly where the seeds end.
  expect(fetched.map((notice) => notice.range.start)).toEqual([
    seededSpan(hydration).until,
  ]);
  await expect(page.getByTestId("fetches")).toHaveText("1");
  // The seeded bars and the forming one; if midnight UTC passed since the
  // server's read, the day that turned final too.
  const bars = await value(page, "bars");
  const expected = seededBars(hydration) + formingBars(hydration);
  expect(bars).toBeGreaterThanOrEqual(expected);
  expect(bars).toBeLessThanOrEqual(expected + 1);
  // A hydration mismatch is reported as an error.
  expect(errors).toEqual([]);
});

test("loading the half-year before fetches only that half-year", async ({
  page,
}) => {
  await open(page);
  const hydration = await hydrationOf(page);
  const since = (await waitNotices(page, 1)).length;
  const bars = await value(page, "bars");
  await page.getByRole("button", { name: "Load the half-year before" }).click();
  await expectOlderHalfYear(page, since, hydration, bars);
});

test("dragging the chart to its left edge loads the half-year before once", async ({
  page,
}) => {
  await open(page);
  const hydration = await hydrationOf(page);
  const since = (await waitNotices(page, 1)).length;
  const bars = await value(page, "bars");
  const box = await page.locator(".chart").boundingBox();
  if (!box) throw new Error("the chart is not on screen");
  // 60 bars to the right at 10 px a bar: the view starts about 35 bars in,
  // so it passes the left edge, and the chart reports it at every step.
  const y = box.y + box.height / 3;
  await page.mouse.move(box.x + 50, y);
  await page.mouse.down();
  await page.mouse.move(box.x + 650, y, { steps: 30 });
  await page.mouse.up();
  await expectOlderHalfYear(page, since, hydration, bars);
});

test("when the worker's host tab crashes, another tab connects a new client", async ({
  context,
}) => {
  test.setTimeout(60_000);
  // The first tab to connect creates the SharedWorker, in its own renderer.
  const host = await context.newPage();
  await open(host);
  const survivor = await context.newPage();
  await open(survivor);
  const seen = (await notices(survivor)).length;
  const dead = host.waitForEvent("crash");
  const cdp = await context.newCDPSession(host);
  // The target dies before it can answer.
  cdp.send("Page.crash").catch(() => {});
  await dead;

  await expect(survivor.locator(".log")).toContainText("worker lost");
  // The new worker starts with an empty cache and no seeds, so the window is
  // fetched again.
  await expect
    .poll(async () =>
      (await notices(survivor))
        .slice(seen)
        .filter((notice) => span(notice) >= HALF_YEAR),
    )
    .toHaveLength(1);
  await expect(survivor.getByTestId("status")).toHaveText("ready");
  await expect(survivor.getByTestId("mode")).toHaveText("shared");
  expect(await value(survivor, "bars")).toBeGreaterThan(100);
});
