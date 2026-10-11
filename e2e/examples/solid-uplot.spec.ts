import { expect, type Page, test } from "@playwright/test";
import { appUrl } from "./apps";
import { notices, recordNotices, span, waitNotices } from "./support";

// examples/solid-uplot: a greenhouse sensor with dropouts, where an empty
// slot inside coverage is a confirmed gap and is never fetched again.

test.use({ baseURL: appUrl("solid-uplot") });
test.describe.configure({ mode: "serial" });

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function count(page: Page, id: string): Promise<number> {
  return page
    .getByTestId(id)
    .textContent()
    .then((text) => Number(text));
}

async function openSixHours(page: Page): Promise<number> {
  await recordNotices(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready");
  await waitNotices(page, 1);
  return count(page, "points");
}

test("loads six hours in one fetch, with confirmed gaps", async ({ page }) => {
  const points = await openSixHours(page);
  await expect(page.getByTestId("mode")).toHaveText("shared");
  const [first, ...later] = await notices(page);
  expect(first && span(first)).toBeGreaterThanOrEqual(6 * HOUR);
  expect(first?.pages).toBe(1);
  expect(later).toEqual([]);
  // Six hours hold 2,160 slots; the sensor leaves some of them empty.
  expect(points).toBeGreaterThan(1000);
  expect(points).toBeLessThan(2160);
  expect(await count(page, "gaps")).toBeGreaterThan(0);
});

test("the last hour is answered from the cache, gaps included", async ({
  page,
}) => {
  const sixHours = await openSixHours(page);
  const before = (await notices(page)).length;
  await page.getByRole("button", { name: "Last hour" }).click();
  await expect.poll(() => count(page, "points")).toBeLessThan(sixHours / 3);
  // At most the seconds since the first fetch: the hour's confirmed gaps
  // are not asked for again.
  const later = (await notices(page)).slice(before);
  expect(later.length).toBeLessThanOrEqual(1);
  for (const notice of later) expect(span(notice)).toBeLessThan(2 * MINUTE);
});

test("the last 24 hours fetch only the 18 hours not yet cached", async ({
  page,
}) => {
  const sixHours = await openSixHours(page);
  const before = (await notices(page)).length;
  await page.getByRole("button", { name: "Last 24 hours" }).click();
  await expect.poll(() => count(page, "points")).toBeGreaterThan(3 * sixHours);
  const later = (await notices(page)).slice(before);
  for (const notice of later) expect(span(notice)).toBeLessThan(23 * HOUR);
  const older = later.filter((notice) => span(notice) >= 17 * HOUR);
  expect(older).toHaveLength(1);
  // 18 hours of 10-second slots take two backend pages.
  expect(older[0]?.pages).toBe(2);
});

test("zooming inside the loaded hours asks the backend for nothing", async ({
  page,
}) => {
  const sixHours = await openSixHours(page);
  const before = (await notices(page)).length;
  const over = page.locator(".u-over").first();
  const box = await over.boundingBox();
  if (!box) throw new Error("the chart has no plot area");
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2, {
    steps: 5,
  });
  await page.mouse.up();
  await expect.poll(() => count(page, "points")).toBeLessThan(sixHours / 2);
  expect(await notices(page)).toHaveLength(before);
});

test("a lost worker is replaced by a new client that refills its cache", async ({
  context,
}) => {
  // The first tab to connect hosts the SharedWorker in its own renderer.
  const host = await context.newPage();
  await openSixHours(host);
  const survivor = await context.newPage();
  await openSixHours(survivor);
  const before = (await notices(survivor)).length;
  const crashed = host.waitForEvent("crash");
  const cdp = await context.newCDPSession(host);
  // The target dies before it can answer.
  cdp.send("Page.crash").catch(() => {});
  await crashed;
  await expect(survivor.locator(".log")).toContainText("worker lost");
  // The new worker starts with an empty cache, so the six hours are fetched
  // again.
  await expect
    .poll(async () =>
      (await notices(survivor))
        .slice(before)
        .some((notice) => span(notice) >= 6 * HOUR),
    )
    .toBe(true);
  await expect(survivor.getByTestId("status")).toHaveText("ready");
  await expect(survivor.getByTestId("mode")).toHaveText("shared");
});
