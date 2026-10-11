import { expect, test } from "@playwright/test";
import { appUrl } from "./apps";
import { notices, recordNotices, span, waitNotices } from "./support";

// examples/vanilla-uplot: a live dashboard over a volatile tail, and sparse
// event counts.

test.use({ baseURL: appUrl("vanilla-uplot") });
test.describe.configure({ mode: "serial" });

const MINUTE = 60_000;

test("the live dashboard fetches its history once, then only the tail", async ({
  page,
}) => {
  await recordNotices(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("live");
  await expect(page.getByTestId("mode")).toHaveText("shared");
  const [first, ...later] = await waitNotices(page, 4);
  expect(first && span(first)).toBeGreaterThanOrEqual(9 * MINUTE);
  // The provisional tail is 30 s, plus the seconds since the last poll and
  // one interval of flank on each side.
  for (const notice of later) expect(span(notice)).toBeLessThan(MINUTE);
  expect(Number(await page.getByTestId("final").textContent())).toBeGreaterThan(
    100,
  );
  expect(
    Number(await page.getByTestId("provisional").textContent()),
  ).toBeGreaterThan(0);
});

test("a restated history clears the cache and is fetched again", async ({
  page,
}) => {
  await recordNotices(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("live");
  await waitNotices(page, 2);
  await page.getByRole("button", { name: /restate history/i }).click();
  await expect(page.locator("#log")).toContainText(
    "cleared (version-mismatch)",
  );
  const before = (await notices(page)).length;
  await expect
    .poll(async () =>
      (await notices(page)).slice(before).some((n) => span(n) >= 9 * MINUTE),
    )
    .toBe(true);
});

test("zooming into the loaded week of events asks the backend for nothing", async ({
  page,
}) => {
  await recordNotices(page);
  await page.goto("/events.html");
  await expect(page.getByTestId("status")).toHaveText("ready");
  const [week] = await waitNotices(page, 1);
  // A week of one-minute slots takes three backend pages.
  expect(week?.pages).toBe(3);
  const events = Number(await page.getByTestId("points").textContent());
  const empty = Number(await page.getByTestId("empty").textContent());
  expect(events).toBeGreaterThan(0);
  expect(events + empty).toBeGreaterThan(7 * 24 * 60);

  const over = page.locator(".u-over");
  const box = await over.boundingBox();
  if (!box) throw new Error("the chart has no plot area");
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2, {
    steps: 5,
  });
  await page.mouse.up();
  await expect
    .poll(async () => Number(await page.getByTestId("empty").textContent()))
    .toBeLessThan(empty / 2);
  expect(await notices(page)).toHaveLength(1);
});
