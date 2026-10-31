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

// The reference clients, each the same page: the live chart in several
// tabs of one SharedWorker.
// One tab holds the live feed and every tab draws its bars without a
// fetch; scrolling fetches only history the cache lacks, with either chart
// library; an expired token is refreshed once across tabs; and the
// server-rendered page starts the cache from the server's read.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** How often the polling feed polls (reference/shared/src/session.ts). */
const POLL_MS = 2000;

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

/**
 * Has the app's server render once, so its cache holds the backend's
 * current dataset version. Its in-process cache outlives tests, and after
 * a test restated the data (bumpVersion) the next render would find the
 * new version only mid-read, clear its cache and serve almost nothing.
 */
async function serverReadsCurrentVersion(page: Page): Promise<void> {
  const response = await page.request.get("/ssr");
  expect(response.ok()).toBe(true);
}

/** The start of the one-minute bar holding `t`. */
function barStart(t: number): number {
  return t - (t % MINUTE);
}

/**
 * Holds the page's event stream back until `release`, so the feed opens,
 * and the page catches up, only when the test lets it.
 */
async function holdStream(page: Page): Promise<{ release(): void }> {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/stream/**", async (route) => {
    await held;
    await route.continue();
  });
  return { release };
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

/** The bar count the page shows. */
async function barCount(page: Page): Promise<number> {
  const text = (await page.getByTestId("summary").textContent()) ?? "";
  return Number(/^(\d+) bars/.exec(text)?.[1] ?? Number.NaN);
}

/**
 * A time the page shows as `MM-DD HH:MM`, without a year, in ms: in the
 * year that puts it nearest `now`, so a time read across New Year is the
 * December before, not the one ahead.
 */
function shownTime(shown: string, now: number): number {
  const year = new Date(now).getUTCFullYear();
  const [nearest] = [year - 1, year, year + 1]
    .map((y) => Date.parse(`${y}-${shown.replace(" ", "T")}:00Z`))
    .sort((a, b) => Math.abs(a - now) - Math.abs(b - now));
  return nearest ?? Number.NaN;
}

/**
 * How many answers the chart drew in full and how many by their newest
 * bars alone, as the views count them on their element
 * (reference/shared/src/chart/view.ts, countDraw).
 */
async function draws(page: Page): Promise<{ full: number; appended: number }> {
  return page.locator("#chart").evaluate((chart) => ({
    full: Number(chart.dataset.drawsFull ?? 0),
    appended: Number(chart.dataset.drawsAppended ?? 0),
  }));
}

/** The start of the range on screen, in ms, by the backend's clock. */
async function showingStart(page: Page): Promise<number> {
  const text = (await page.getByTestId("showing").textContent()) ?? "";
  return shownTime(text.split(" – ")[0] ?? "", (await stats(page)).now);
}

test("a time shown without a year reads in the year nearest the clock", () => {
  const newYear = Date.UTC(2027, 0, 1, 1);
  expect(shownTime("12-31 20:00", newYear)).toBe(Date.UTC(2026, 11, 31, 20));
  expect(shownTime("01-01 00:30", newYear)).toBe(Date.UTC(2027, 0, 1, 0, 30));
  const midYear = Date.UTC(2026, 6, 1);
  expect(shownTime("06-30 23:59", midYear)).toBe(Date.UTC(2026, 5, 30, 23, 59));
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

for (const app of [
  "reference-vanilla",
  "reference-react",
  "reference-solid",
] as const) {
  test.describe(app, () => {
    test.use({ baseURL: appUrl(app) });
    test.describe.configure({ mode: "serial" });
    // Some tests move the backend's clock on; every test starts on the real one.
    test.afterEach(async ({ request }) => {
      await request.post("/api/control", { data: { resetClock: true } });
    });

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
      test(`a live bar draws only the newest bars, not every bar (${chart}, step 41)`, async ({
        context,
      }) => {
        const page = await openTab(context, `/?chart=${chart}`);
        // The opening answer draws every bar.
        await expect
          .poll(async () => (await draws(page)).full)
          .toBeGreaterThan(0);
        await nextDraw(page);
        const before = await draws(page);
        await nextDraw(page);
        await nextDraw(page);
        const after = await draws(page);
        expect(after.appended).toBeGreaterThanOrEqual(before.appended + 2);
        expect(after.full).toBe(before.full);
      });
    }

    test("a dataset version pushed with a bar draws every bar again (step 41)", async ({
      context,
    }) => {
      const page = await openTab(context);
      await waitNotices(page, 1);
      await nextDraw(page);
      const before = await draws(page);
      await control(page, { bumpVersion: true });
      await expect
        .poll(async () => (await draws(page)).full)
        .toBeGreaterThan(before.full);
      await expect.poll(() => barCount(page)).toBeGreaterThan(600);
    });

    test("choosing a feed in one tab switches every tab", async ({
      context,
    }) => {
      const a = await openTab(context);
      const b = await openTab(context);
      await a.selectOption("#feed-kind", "ws");
      await expect(b.locator("#feed-kind")).toHaveValue("ws");
      // The socket replaces the event stream, and its bars reach both tabs
      // (that they cost no fetch, the feeds' own tests show).
      await expect.poll(async () => (await stats(a)).streams).toBe(1);
      await nextDraw(a);
      await nextDraw(b);
      await b.selectOption("#feed-kind", "poll");
      await expect(a.locator("#feed-kind")).toHaveValue("poll");
      await expect.poll(async () => (await stats(a)).streams).toBe(0);
      await nextDraw(a);
      await nextDraw(b);
    });

    for (const chart of ["lightweight", "uplot"] as const) {
      test(`scrolling back fetches only the history the cache lacks (${chart})`, async ({
        context,
      }) => {
        const page = await openTab(context, `/?chart=${chart}`);
        await waitNotices(page, 1);
        const opened = await barCount(page);
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
        // The read reaching back answered: it spans a screen more of
        // history than the opening's (a pushed bar adds one).
        await expect.poll(() => barCount(page)).toBeGreaterThan(opened + 100);
        const scrolled = await barCount(page);
        // Back where it was: the history is answered from the cache. A read
        // that fetched would post its notice before its answer arrived.
        const settled = (await notices(page)).length;
        await drag(page, "forward");
        await expect.poll(() => barCount(page)).toBeLessThan(scrolled - 100);
        const back = (await notices(page)).slice(settled);
        expect(back.filter(isHistory)).toEqual([]);
        // Every page, the server's reads included, came as a columns body.
        const { formats } = await stats(page);
        expect(formats.columns).toBeGreaterThan(0);
        expect(formats.json).toBe(0);
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
      await serverReadsCurrentVersion(page);
      await recordNotices(page);
      const response = await page.goto("/ssr");
      const html = (await response?.text()) ?? "";
      // The server's markup carries the answer, and its read for the cache.
      expect(html).toMatch(/data-testid="summary">\d+ bars, last close/);
      expect(html).toContain('id="tscache-read"');
      await expect(page.getByTestId("connection")).toHaveText("live");
      await expect(page.locator("#chart canvas").first()).toBeVisible();
      // The forming bar is provisional, so the page fetches it every time.
      await waitNotices(page, 1);
      // clock-ok: what else the page fetches in its first second; a slow machine can only leave a fetch unchecked.
      await page.waitForTimeout(1000);
      for (const notice of await notices(page)) {
        expect(span(notice)).toBeLessThanOrEqual(2 * MINUTE);
      }
    });

    // The page catches up with a fetch when its feed opens. A minute
    // boundary passing between the read before it and the catch-up must
    // not widen that fetch past the forming bar and the one before (fix 31).
    // Both tests hold the stream back, pin the page's clock in the next bar,
    // then let the stream open: the boundary passes every run.

    test("the server-rendered page fetches only the newest bars when a minute passes before its feed opens", async ({
      context,
    }) => {
      const page = await context.newPage();
      await serverReadsCurrentVersion(page);
      await recordNotices(page);
      const opening = await holdStream(page);
      await page.goto("/ssr");
      await expect(page.getByTestId("connection")).toHaveText("live");
      const served = await page
        .locator("#tscache-read")
        .evaluate((script) => JSON.parse(script.textContent ?? "{}"));
      const rendered: number = served.range.end;
      // Halfway through the bar after the one the server rendered in.
      await page.clock.setFixedTime(barStart(rendered) + MINUTE + MINUTE / 2);
      await waitNotices(page, 1);
      const before = (await notices(page)).length;
      opening.release();
      await waitNotices(page, before + 1);
      for (const notice of await notices(page)) {
        expect(span(notice)).toBeLessThanOrEqual(2 * MINUTE);
      }
    });

    test("a page whose feed opens a minute after its first read fetches only the newest bars", async ({
      context,
    }) => {
      const page = await context.newPage();
      // The backend's clock a second into a bar, so its forming bar stays
      // the same while the page reads (resetClock in afterEach undoes it).
      const backendNow = (await stats(page)).now;
      await control(page, {
        advanceMs: MINUTE - (backendNow % MINUTE) + 1000,
      });
      const forming = barStart((await stats(page)).now);
      await page.clock.setFixedTime(forming + MINUTE / 2);
      await recordNotices(page);
      const opening = await holdStream(page);
      await page.goto("/");
      await expect(page.getByTestId("connection")).toHaveText("live");
      await waitNotices(page, 1);
      const before = (await notices(page)).length;
      await page.clock.setFixedTime(forming + MINUTE + MINUTE / 2);
      opening.release();
      await waitNotices(page, before + 1);
      for (const notice of (await notices(page)).slice(before)) {
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
      expect(
        Math.abs((await showingStart(page)) - scrolled),
      ).toBeLessThanOrEqual(2 * MINUTE);
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

    test("an answer without bars clears the uPlot chart (R2-1)", async ({
      context,
    }) => {
      const page = await openTab(context, "/?chart=uplot");
      await waitNotices(page, 1);
      // Two screens back, so the range read holds no bar the feed pushes.
      for (let i = 0; i < 2; i++) {
        const before = (await notices(page)).length;
        const bars = await barCount(page);
        await drag(page, "back");
        await waitHistory(page, before);
        // Drawn: the read a screen further back holds more bars.
        await expect.poll(() => barCount(page)).toBeGreaterThan(bars);
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
        localStorage.setItem(
          key,
          JSON.stringify({ ...tokens, refresh: "rt-x" }),
        );
      });
      await control(a, { expireAccess: true });
      await drag(a, "back");
      await expect(a.getByTestId("auth")).toHaveText("signed out");
      await expect(b.getByTestId("auth")).toHaveText("signed out");
      await a.getByRole("button", { name: "Sign in again" }).click();
      await expect(a.getByTestId("auth")).toHaveText("signed in");
      await expect(b.getByTestId("auth")).toHaveText("signed in");
      await expect(
        b.getByRole("button", { name: "Sign in again" }),
      ).toBeHidden();
    });

    test("bars after a gap in the stream are read through it while the chart follows (R3-1)", async ({
      context,
    }) => {
      const page = await context.newPage();
      // The page's clock three minutes behind the backend's: its first read
      // ends three bars before the first pushed bar, as after a stream outage.
      await page.clock.setSystemTime((await stats(page)).now - 3 * MINUTE);
      await recordNotices(page);
      await page.goto("/");
      await expect(page.getByTestId("connection")).toHaveText("live");
      await expect(page.getByTestId("summary")).toContainText("bars");
      const fetched = (await notices(page)).length;
      const opened = await barCount(page);
      // The fetch flank reaches one bar past the read, so two remain to fill.
      await expect
        .poll(() => barCount(page))
        .toBeGreaterThanOrEqual(opened + 2);
      expect((await notices(page)).length).toBeGreaterThan(fetched);
      // Then the chart follows the stream again.
      await nextDraw(page);
    });

    test("a stream that reopens a bar later mends the bar it broke in (R4-1)", async ({
      context,
    }) => {
      const page = await openTab(context);
      await waitNotices(page, 1);
      await nextDraw(page);
      const fetched = (await notices(page)).length;
      // The bar forming now, as the backend sees it, stays provisional in the
      // cache when the stream breaks.
      const forming = Math.floor((await stats(page)).now / MINUTE) * MINUTE;
      // One request, so no batch comes between: the stream breaks, a minute
      // passes, and the new stream sends only the next bar.
      await control(page, { dropStreams: true, advanceMs: MINUTE });
      // The new stream's opening reads over the bar the old one broke in.
      await expect
        .poll(async () =>
          (await notices(page))
            .slice(fetched)
            .some((notice) => notice.range.end >= forming),
        )
        .toBe(true);
      await nextDraw(page);
    });

    test("a stream that reopens while another chart library loads still mends the broken bar (step 18 R1-1)", async ({
      context,
    }) => {
      const page = await openTab(context);
      await waitNotices(page, 1);
      await nextDraw(page);
      // Hold the uPlot chunk back until the stream has reopened.
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route("**/assets/uplot-*.js", async (route) => {
        await held;
        await route.continue();
      });
      const fetched = (await notices(page)).length;
      const forming = Math.floor((await stats(page)).now / MINUTE) * MINUTE;
      await page.selectOption("#chart-kind", "uplot");
      await control(page, { dropStreams: true, advanceMs: MINUTE });
      await expect
        .poll(async () =>
          (await notices(page))
            .slice(fetched)
            .some((notice) => notice.range.end >= forming),
        )
        .toBe(true);
      release();
      await expect(page.locator("#chart .u-over")).toBeVisible();
    });

    test("bars that arrive while another chart library loads keep the page following (step 18 R2-1)", async ({
      context,
    }) => {
      const page = await openTab(context);
      await waitNotices(page, 1);
      await nextDraw(page);
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route("**/assets/uplot-*.js", async (route) => {
        await held;
        await route.continue();
      });
      await page.selectOption("#chart-kind", "uplot");
      // Two bars on while the chunk is held: the pushes, read from the
      // cache alone, move the read range past where the old chart was.
      await control(page, { advanceMs: 2 * MINUTE });
      await nextDraw(page);
      await nextDraw(page);
      const fetched = (await notices(page)).length;
      const forming = Math.floor((await stats(page)).now / MINUTE) * MINUTE;
      await control(page, { dropStreams: true, advanceMs: MINUTE });
      await expect
        .poll(async () =>
          (await notices(page))
            .slice(fetched)
            .some((notice) => notice.range.end >= forming),
        )
        .toBe(true);
      release();
      await expect(page.locator("#chart .u-over")).toBeVisible();
    });

    // The other feeds. What the page does with new bars is the same in
    // every client (reference/shared), so they run against one.
    if (app === "reference-vanilla") {
      test("one tab holds the WebSocket, and every tab draws its bars without a fetch", async ({
        context,
      }) => {
        const a = await openTab(context, "/?feed=ws");
        const b = await openTab(context, "/?feed=ws");
        await expect(b.locator("#feed-kind")).toHaveValue("ws");
        await expect.poll(async () => (await stats(a)).streams).toBe(1);
        const fetched = (await notices(b)).length;
        await nextDraw(a);
        await nextDraw(b);
        await nextDraw(b);
        expect((await notices(b)).length).toBe(fetched);
        // The holder leaves; the other tab opens the socket again.
        await a.close();
        await expect.poll(async () => (await stats(b)).streams).toBe(1);
        await nextDraw(b);
      });

      test("a socket that reopens a bar later mends the bar it broke in", async ({
        context,
      }) => {
        const page = await openTab(context, "/?feed=ws");
        await waitNotices(page, 1);
        await nextDraw(page);
        const fetched = (await notices(page)).length;
        const forming = Math.floor((await stats(page)).now / MINUTE) * MINUTE;
        await control(page, { dropStreams: true, advanceMs: MINUTE });
        await expect
          .poll(async () =>
            (await notices(page))
              .slice(fetched)
              .some((notice) => notice.range.end >= forming),
          )
          .toBe(true);
        await nextDraw(page);
      });

      test("a socket refused for a stale token refreshes it once and reconnects", async ({
        context,
      }) => {
        const a = await openTab(context, "/?feed=ws");
        const b = await openTab(context, "/?feed=ws");
        await expect.poll(async () => (await stats(a)).streams).toBe(1);
        const before = await stats(a);
        // The socket reconnects with the token the backend no longer accepts.
        await control(a, { expireAccess: true, dropStreams: true });
        await expect
          .poll(async () => (await stats(a)).refreshes)
          .toBe(before.refreshes + 1);
        await expect.poll(async () => (await stats(a)).streams).toBe(1);
        const after = await stats(a);
        expect(after.refused).toBeGreaterThan(before.refused);
        expect(after.reused).toBe(before.reused);
        await nextDraw(a);
        await nextDraw(b);
        await expect(a.getByTestId("auth")).toHaveText("signed in");
        await expect(b.getByTestId("auth")).toHaveText("signed in");
      });

      test("a socket whose session was lost reconnects after a sign-in in its own tab (step 20 R1-2)", async ({
        context,
      }) => {
        const page = await openTab(context, "/?feed=ws");
        await expect.poll(async () => (await stats(page)).streams).toBe(1);
        // A refresh token the backend refuses: the socket's refresh fails.
        await page.evaluate(() => {
          const key = "tscache-reference:tokens";
          const tokens = JSON.parse(localStorage.getItem(key) ?? "{}");
          localStorage.setItem(
            key,
            JSON.stringify({ ...tokens, refresh: "rt-x" }),
          );
        });
        await control(page, { expireAccess: true, dropStreams: true });
        await expect(page.getByTestId("auth")).toHaveText("signed out");
        expect((await stats(page)).streams).toBe(0);
        await page.getByRole("button", { name: "Sign in again" }).click();
        await expect(page.getByTestId("auth")).toHaveText("signed in");
        await expect.poll(async () => (await stats(page)).streams).toBe(1);
        await nextDraw(page);
      });

      test("one tab polls, fetching only the newest bars, and the others draw without a fetch", async ({
        context,
      }) => {
        const a = await openTab(context, "/?feed=poll");
        const b = await openTab(context, "/?feed=poll");
        await expect(b.getByTestId("mode")).toHaveText("shared");
        expect((await stats(a)).streams).toBe(0);
        await nextDraw(b);
        // Notices are the origin's: every tab hears every tab's fetches.
        const before = (await notices(b)).length;
        // clock-ok: elapsed time bounds the poll count from above; a slow machine only lengthens it.
        const started = Date.now();
        await nextDraw(a);
        await nextDraw(b);
        await nextDraw(b);
        // clock-ok: as above.
        const elapsed = Date.now() - started;
        const polls = (await notices(b)).slice(before);
        expect(polls.length).toBeGreaterThan(0);
        // One fetch per poll: the other tab draws from the cache the poll
        // filled, which a second fetch per poll would double.
        expect(polls.length).toBeLessThanOrEqual(
          Math.floor(elapsed / POLL_MS) + 1,
        );
        for (const notice of polls) {
          expect(span(notice)).toBeLessThanOrEqual(2 * MINUTE);
        }
      });
    }
  });
}
