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
