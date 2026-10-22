import { expect, type Page, test } from "@playwright/test";
import type { Hydration } from "../../examples/mock-backend/src/hydration";
import type { FetchNotice } from "../../examples/mock-backend/src/notices";
import type { ServerRead } from "../../examples/solid-ssr/src/sensor";
import { appUrl } from "./apps";
import {
  coveredPoints,
  coveredSpan,
  logCount,
  logSince,
  notices,
  recordNotices,
  waitNotices,
} from "./support";

// examples/solid-ssr: the server reads the last 24 hours of a sensor with an
// in-process client shared by every render, and writes the read's snapshot
// into the page. The browser hydrates its cache from it and fetches only
// what it does not cover; the dropouts inside it are known without a fetch.

test.use({ baseURL: appUrl("solid-ssr") });
test.describe.configure({ mode: "serial" });

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const minuteOf = (t: number) => Math.floor(t / MINUTE) * MINUTE;

async function count(page: Page, id: string): Promise<number> {
  return Number(await page.getByTestId(id).textContent());
}

/** A jsonScript() element of the page: its props or its hydration. */
async function script<T>(page: Page, id: string): Promise<T> {
  return JSON.parse((await page.locator(`#${id}`).textContent()) ?? "") as T;
}

const read = (page: Page) => script<ServerRead>(page, "app-props");
const hydration = (page: Page) => script<Hydration>(page, "tscache-hydration");

/** Where the snapshot's coverage ends, which the browser need not fetch. */
async function seedsEnd(page: Page): Promise<number> {
  return coveredSpan((await hydration(page)).snapshot).until;
}

async function open(page: Page): Promise<void> {
  await recordNotices(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready");
  await expect(page.getByTestId("mode")).toHaveText("shared");
}

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("the server renders the figures, and its seeds cover its window", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByTestId("status")).toHaveText("server-rendered");
    await expect(page.getByTestId("mode")).toHaveText("in-process");
    await expect(page.getByTestId("fetches")).toHaveText("0");
    const readings = await count(page, "readings");
    const knownEmpty = await count(page, "known-empty");
    // 24 hours hold about 1,441 minute slots; the sensor leaves some empty.
    expect(readings).toBeGreaterThan(1000);
    expect(knownEmpty).toBeGreaterThan(0);

    const { window, figures } = await read(page);
    expect(figures.readings).toBe(readings);
    const { range, snapshot } = await hydration(page);
    expect(range).toEqual(window);
    // The read snaps outward to the minute grid, so it ends at the minute
    // after now, which is still provisional: coverage ends a minute earlier,
    // at the minute the render began in, or at the next one when a minute
    // began before the backend answered.
    expect(snapshot.coverage).toHaveLength(1);
    const covered = snapshot.coverage[0] ?? {
      start: Number.NaN,
      end: Number.NaN,
    };
    expect(covered.start).toBe(minuteOf(window.start));
    expect([minuteOf(window.end), minuteOf(window.end) + MINUTE]).toContain(
      covered.end,
    );
    // Every covered slot holds a reading or is known to be empty.
    expect(readings + knownEmpty).toBe(
      (covered.end - covered.start) / MINUTE + 1,
    );
    // Every reading travels with the snapshot.
    expect(coveredPoints(snapshot)).toHaveLength(readings);
    await expect(
      page.getByRole("button", { name: "Load the previous day" }),
    ).toBeDisabled();
  });
});

test("after hydration the browser fetches only what the seeds do not cover", async ({
  page,
}) => {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      problems.push(message.text());
    }
  });
  await open(page);
  const covered = await seedsEnd(page);
  const fetched = await waitNotices(page, 1);
  // The minutes since the server's read: their miss abuts the seeds'
  // coverage and is extended one interval into it, so it starts exactly at
  // its end. The confirmed gaps inside the seeds are never fetched.
  expect(fetched[0]?.range.start).toBe(covered);
  for (const notice of fetched) {
    expect(notice.range.start).toBeGreaterThanOrEqual(covered);
  }
  await expect(page.getByTestId("fetches")).toHaveText(String(fetched.length));
  const { figures } = await read(page);
  expect(await count(page, "readings")).toBeGreaterThanOrEqual(
    figures.readings,
  );
  expect(await count(page, "known-empty")).toBeGreaterThanOrEqual(
    figures.knownEmpty,
  );
  expect(problems).toEqual([]);
});

test("the server's cache serves later renders", async ({ page }) => {
  async function render(): Promise<{ props: ServerRead; shown: number }> {
    const html = await (await page.request.get("/")).text();
    const json =
      /<script id="app-props" type="application\/json">(.*?)<\/script>/;
    const shown = /data-testid="server-cached">(\d+)</;
    return {
      props: JSON.parse(json.exec(html)?.[1] ?? ""),
      shown: Number(shown.exec(html)?.[1]),
    };
  }
  const first = await render();
  const second = await render();

  expect(second.shown).toBe(second.props.cached);
  // Everything the first render read, except the reading in the second
  // window's first minute when a minute began between the two renders.
  const shifted =
    (minuteOf(second.props.window.start) - minuteOf(first.props.window.start)) /
    MINUTE;
  expect(second.props.cached).toBeGreaterThanOrEqual(
    first.props.figures.readings - shifted,
  );
  // The second render fetched only the minutes since the first, where a
  // cache of its own would have fetched the whole day.
  expect(
    second.props.figures.readings - second.props.cached,
  ).toBeLessThanOrEqual(2);
});

test("loading the previous day fetches only that day", async ({ page }) => {
  await open(page);
  const coverageStart = coveredSpan((await hydration(page)).snapshot).from;
  const [tail] = await waitNotices(page, 1);
  if (tail === undefined) throw new Error("no fetch after hydration");
  const readings = await count(page, "readings");
  const since = (await notices(page)).length;

  await page.getByRole("button", { name: "Load the previous day" }).click();
  await expect
    .poll(() => count(page, "readings"))
    .toBeGreaterThan(readings + 1000);
  await expect(page.getByTestId("status")).toHaveText("ready");

  const later = async () => (await notices(page)).slice(since);
  const isOlder = (notice: FetchNotice) =>
    notice.range.start < tail.range.start;
  await expect
    .poll(async () => (await later()).filter(isOlder))
    .toHaveLength(1);
  const all = await later();
  // The older day's miss abuts the coverage, so it ends one interval into it.
  expect(all.filter(isOlder).map((notice) => notice.range)).toEqual([
    { start: coverageStart - DAY, end: coverageStart },
  ]);
  // Anything else is the minutes since the last get, which covered up to
  // the minute before the one its fetch ended in.
  for (const notice of all.filter((n) => !isOlder(n))) {
    expect(notice.range.start).toBeGreaterThanOrEqual(tail.range.end - MINUTE);
  }
});

test("when the worker's host tab crashes, another tab connects a new client and goes on", async ({
  context,
}) => {
  test.setTimeout(60_000);
  // The first tab to connect creates the SharedWorker, in its own renderer.
  const host = await context.newPage();
  await open(host);
  const survivor = await context.newPage();
  await open(survivor);
  const covered = await seedsEnd(survivor);
  // The second tab's seeds and the first tab's fetches cover the day, so
  // its one fetch starts at or after its seeds' end. Waiting for it also
  // keeps it out of the fetches checked after the crash: its notice and
  // the get's answer travel on different channels.
  const before = await waitNotices(survivor, 1);
  for (const notice of before) {
    expect(notice.range.start).toBeGreaterThanOrEqual(covered);
  }
  const since = before.length;

  const dead = host.waitForEvent("crash");
  const cdp = await context.newCDPSession(host);
  // The target dies before it can answer.
  cdp.send("Page.crash").catch(() => {});
  await dead;

  await expect(survivor.locator(".log")).toContainText("worker lost");
  // The new worker starts empty and the page's snapshot seeds it (N39,
  // every client): something is applied, and the day is not fetched again.
  await expect
    .poll(() => logCount(survivor, "snapshot from the server"))
    .toBe(2);
  await expect(survivor.getByTestId("status")).toHaveText("ready");
  const replaced = await logSince(survivor, "worker lost");
  expect(replaced).toContain("snapshot from the server");
  expect(replaced).not.toContain("snapshot from the server: 0 range");
  expect(
    (await notices(survivor))
      .slice(since)
      .filter((notice) => notice.range.end - notice.range.start >= DAY),
  ).toEqual([]);
  await expect(survivor.getByTestId("mode")).toHaveText("shared");

  const readings = await count(survivor, "readings");
  await survivor.getByRole("button", { name: "Load the previous day" }).click();
  await expect
    .poll(() => count(survivor, "readings"))
    .toBeGreaterThan(readings + 1000);
});
