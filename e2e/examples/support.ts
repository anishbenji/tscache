// Helpers for the example specs. Each app runs on its own `vite preview`
// server with its own in-memory mock backend, so specs of one app run
// serially and read backend counters as differences.

import { expect, type Page } from "@playwright/test";
import type {
  BackendControl,
  BackendStats,
} from "../../examples/mock-backend/src/backend";
import {
  type FetchNotice,
  NOTICE_CHANNEL,
} from "../../examples/mock-backend/src/notices";
import type { EncodedSnapshot } from "../../packages/tscache/src/types";

declare global {
  interface Window {
    __notices?: FetchNotice[];
  }
}

/**
 * Records every fetch notice the page receives, from before its first
 * script runs. Notices come from any tab's worker on the same origin and in
 * the same browser context.
 */
export async function recordNotices(page: Page): Promise<void> {
  await page.addInitScript((channel) => {
    const notices: FetchNotice[] = [];
    window.__notices = notices;
    new BroadcastChannel(channel).onmessage = (event) => {
      notices.push(event.data);
    };
  }, NOTICE_CHANNEL);
}

export function notices(page: Page): Promise<FetchNotice[]> {
  return page.evaluate(() => window.__notices ?? []);
}

/** Waits until the page has recorded at least `n` notices, and returns them. */
export async function waitNotices(
  page: Page,
  n: number,
): Promise<FetchNotice[]> {
  await expect
    .poll(async () => (await notices(page)).length)
    .toBeGreaterThanOrEqual(n);
  return notices(page);
}

export async function stats(page: Page): Promise<BackendStats> {
  const response = await page.request.get("/api/stats");
  return response.json();
}

export async function control(page: Page, body: BackendControl): Promise<void> {
  await page.request.post("/api/control", { data: body });
}

/** The span of a notice's range in ms. */
export function span({ range }: FetchNotice): number {
  return range.end - range.start;
}

/** Where a snapshot's coverage starts and ends. */
export function coveredSpan(snapshot: EncodedSnapshot): {
  from: number;
  until: number;
} {
  const first = snapshot.coverage.at(0);
  const last = snapshot.coverage.at(-1);
  if (first === undefined || last === undefined) {
    throw new Error("the snapshot covers nothing");
  }
  return { from: first.start, until: last.end };
}

/**
 * The timestamps of a snapshot's present points inside its coverage: what
 * hydrate puts into an empty cache. Decoded from the payload masks
 * (architecture §3.4: slot i is bit i & 7 of byte i >> 3).
 */
export function coveredPoints(snapshot: EncodedSnapshot): number[] {
  const out: number[] = [];
  for (const payload of snapshot.segments) {
    // The examples cache fixed grids: slot i is at start + i * interval.
    if (payload.format !== 1) throw new Error("expected a fixed-grid payload");
    const mask = atob(payload.mask);
    for (let i = 0; i < payload.count; i++) {
      if (((mask.charCodeAt(i >> 3) >> (i & 7)) & 1) === 0) continue;
      const t = payload.start + i * payload.interval;
      if (snapshot.coverage.some((r) => r.start <= t && t <= r.end)) {
        out.push(t);
      }
    }
  }
  return out;
}

/** How often `text` appears in the page's log. */
export async function logCount(page: Page, text: string): Promise<number> {
  const log = (await page.locator(".log").textContent()) ?? "";
  return log.split(text).length - 1;
}

/**
 * The page's log entries written since the latest `marker` entry. The logs
 * list the newest entry first, so that is the text before the marker's
 * first occurrence.
 */
export async function logSince(page: Page, marker: string): Promise<string> {
  const log = (await page.locator(".log").textContent()) ?? "";
  const at = log.indexOf(marker);
  return at < 0 ? "" : log.slice(0, at);
}

const HYDRATION =
  /(<script id="tscache-hydration" type="application\/json">)(.*?)(<\/script>)/;

/**
 * Serves the page with its hydration element's text replaced by
 * `change(text)`; everything else is as the server wrote it. Returns the
 * texts the server wrote, one per page served, in order.
 */
async function serveHydration(
  page: Page,
  change: (text: string) => string,
): Promise<string[]> {
  const served: string[] = [];
  await page.route("/", async (route) => {
    const response = await route.fetch();
    const html = await response.text();
    const found = HYDRATION.exec(html);
    if (found === null) throw new Error("the page carries no hydration");
    const text = found[2] ?? "";
    served.push(text);
    await route.fulfill({
      response,
      body: html.replace(
        HYDRATION,
        () => `${found[1]}${change(text)}${found[3]}`,
      ),
    });
  });
  return served;
}

/**
 * Serves the page with its snapshot's first segment given twice, so the
 * browser's `hydrate` refuses it part way through validation: the second
 * segment overlaps the first (architecture §8, N35). Everything else in the
 * page, the snapshot's range and coverage included, is as the server wrote
 * it.
 */
export async function serveCorruptSnapshot(page: Page): Promise<void> {
  await serveHydration(page, (text) => {
    const hydration = JSON.parse(text) as { snapshot: EncodedSnapshot };
    const [first] = hydration.snapshot.segments;
    if (first === undefined) throw new Error("the snapshot has no segment");
    hydration.snapshot.segments = [first, ...hydration.snapshot.segments];
    return JSON.stringify(hydration).replaceAll("<", "\\u003c");
  });
}

/**
 * Serves the page with its hydration's text cut in half, so it is not
 * JSON, as a truncated response would be; the page's other elements are as
 * the server wrote them. Returns the hydrations the server wrote, one per
 * page served, in order.
 */
export async function serveTruncatedHydration(page: Page): Promise<string[]> {
  return serveHydration(page, (text) => text.slice(0, text.length / 2));
}
