import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import type { FetchNotice } from "../../examples/mock-backend/src/notices";
import { appUrl } from "./apps";
import { notices, recordNotices, span, stats, waitNotices } from "./support";

// examples/react-lwcharts: two tabs on one SharedWorker, one token refresh
// for all tabs, one sign-in after a lost session, and a new client after the
// worker's host tab crashes. Pages of one BrowserContext share the
// SharedWorker; contexts would isolate it.

test.use({ baseURL: appUrl("react-lwcharts") });
test.describe.configure({ mode: "serial" });

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** A refresh every 5 s, plus the backend's latency. */
const NEXT_REFRESH = { timeout: 15_000 };

async function openTab(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await recordNotices(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready");
  await expect(page.getByTestId("mode")).toHaveText("shared");
  return page;
}

function isHistory(notice: FetchNotice): boolean {
  return span(notice) > 2 * DAY;
}

/** Where the app keeps the tokens all its tabs share. */
const TOKENS_KEY = "tscache-example:tokens";

function logText(page: Page): Promise<string> {
  return page.locator("#log").innerText();
}

/** Waits until the page draws a newer answer than the one it shows now. */
async function nextDraw(page: Page): Promise<void> {
  const updated = page.getByTestId("updated");
  const shown = (await updated.textContent()) ?? "";
  await expect(updated).not.toHaveText(shown, NEXT_REFRESH);
}

test("a second tab draws the history the first fetched, fetching only the tail", async ({
  context,
}) => {
  const a = await openTab(context);
  const [first] = await waitNotices(a, 1);
  if (first === undefined) throw new Error("no fetch notice");
  // The request snaps outward to the 5-minute grid.
  expect(span(first)).toBeGreaterThanOrEqual(3 * DAY);
  expect(span(first)).toBeLessThanOrEqual(3 * DAY + 10 * MINUTE);

  const b = await openTab(context);
  expect(Number(await b.getByTestId("bars").textContent())).toBeGreaterThan(0);
  // B's first get fetched only the bar forming now; later polls of both
  // tabs do the same.
  await expect
    .poll(async () => (await notices(b)).length, NEXT_REFRESH)
    .toBeGreaterThanOrEqual(3);
  for (const notice of await notices(b)) {
    expect(span(notice)).toBeLessThan(HOUR);
  }
  const all = await notices(a);
  expect(all.filter(isHistory)).toHaveLength(1);
  for (const notice of all.slice(1)) expect(span(notice)).toBeLessThan(HOUR);
  await expect(b.getByTestId("fetches")).not.toHaveText("0");
});

test("an expired token is refreshed once and every tab recovers", async ({
  context,
}) => {
  test.setTimeout(60_000);
  const a = await openTab(context);
  const b = await openTab(context);
  const before = await stats(a);
  await a.getByRole("button", { name: "Expire access token" }).click();
  // One refusal, broadcast to every tab with the refused context.
  for (const page of [a, b]) {
    await expect(page.getByTestId("authInvalid")).toHaveText("1", NEXT_REFRESH);
  }
  await expect
    .poll(async () => (await stats(a)).refreshes - before.refreshes)
    .toBe(1);
  for (const page of [a, b]) {
    await expect(page.getByTestId("auth")).toHaveText("ok", NEXT_REFRESH);
    // Later refreshes stay complete: the tail is fetched with the new token.
    await nextDraw(page);
    await expect(page.getByTestId("auth")).toHaveText("ok");
    await expect(
      page.getByRole("button", { name: "Sign in again" }),
    ).toBeHidden();
  }
  const after = await stats(a);
  expect(after.refreshes - before.refreshes).toBe(1);
  expect(after.reused - before.reused).toBe(0);
  expect(after.refused).toBeGreaterThan(before.refused);
  for (const page of [a, b]) {
    await expect(page.getByTestId("authInvalid")).toHaveText("1");
  }
  // The get whose fetch was refused answered without waiting for the
  // refresh, with the tail as an auth-pending miss.
  const logs = await Promise.all([a, b].map(logText));
  expect(logs.join("\n")).toContain("miss: auth-pending");
});

test("after a lost session, one tab's sign-in recovers every tab", async ({
  context,
}) => {
  test.setTimeout(60_000);
  const a = await openTab(context);
  const b = await openTab(context);
  const before = await stats(a);
  // As if another tab had spent the refresh token and failed to store the
  // new pair: the snippet's tombstone.
  await a.evaluate((key) => {
    const tokens = JSON.parse(localStorage.getItem(key) ?? "{}");
    localStorage.setItem(key, JSON.stringify({ ...tokens, refresh: null }));
  }, TOKENS_KEY);
  await a.getByRole("button", { name: "Expire access token" }).click();
  for (const page of [a, b]) {
    await expect(
      page.getByRole("button", { name: "Sign in again" }),
    ).toBeVisible(NEXT_REFRESH);
    await expect(page.getByTestId("auth")).toHaveText("pending");
  }
  await a.getByRole("button", { name: "Sign in again" }).click();
  for (const page of [a, b]) {
    await expect(page.getByTestId("auth")).toHaveText("ok", NEXT_REFRESH);
    await expect(
      page.getByRole("button", { name: "Sign in again" }),
    ).toBeHidden();
  }
  const after = await stats(a);
  expect(after.refreshes - before.refreshes).toBe(0);
  expect(after.reused - before.reused).toBe(0);
});

test("when the worker's host tab crashes, the other tab connects a new client", async ({
  context,
}) => {
  test.setTimeout(60_000);
  // The first tab to connect creates the SharedWorker, in its own renderer.
  const host = await openTab(context);
  const survivor = await openTab(context);
  const seen = (await notices(survivor)).length;
  const dead = host.waitForEvent("crash");
  const cdp = await context.newCDPSession(host);
  // The target dies before it can answer.
  cdp.send("Page.crash").catch(() => {});
  await dead;

  await expect(survivor.locator("#log")).toContainText("worker lost");
  await expect(survivor.getByTestId("mode")).toHaveText("shared");
  await expect(survivor.getByTestId("status")).toHaveText(
    "ready",
    NEXT_REFRESH,
  );
  // The new worker starts with an empty cache, so the history is fetched
  // again.
  await expect
    .poll(
      async () => (await notices(survivor)).slice(seen).filter(isHistory),
      NEXT_REFRESH,
    )
    .toHaveLength(1);
  expect(
    Number(await survivor.getByTestId("bars").textContent()),
  ).toBeGreaterThan(0);
  await nextDraw(survivor);
  await expect(survivor.getByTestId("status")).toHaveText("ready");
});
