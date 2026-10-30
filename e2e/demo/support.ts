// Helpers for the demo hub's specs (hub.spec.ts and shared.spec.ts).

import { expect, type Page, test } from "@playwright/test";
import { catalog, type Launch } from "../../scripts/demo/catalog";
import type { App } from "../examples/apps";

/**
 * Apps with backend-wide state that a test changes: react-lwcharts holds one
 * token pair for every browser context (a refresh in one context makes the
 * others' refresh token stale, ending their session), and solid-uplot's data
 * version is one number. Their tests, and every test that opens one of their
 * pages, run in the demo-shared project, one at a time
 * (playwright.config.ts), so no run changes that state under another.
 */
export const SHARED_STATE: ReadonlySet<App> = new Set([
  "react-lwcharts",
  "solid-uplot",
]);

/** A table cell of the backends panel. */
export function cell(hub: Page, app: App, field: string) {
  return hub.locator(`tr[data-app="${app}"] td[data-field="${field}"]`);
}

export async function count(
  hub: Page,
  app: App,
  field: string,
): Promise<number> {
  return Number(await cell(hub, app, field).textContent());
}

/** Clicks the hub's link to the launch, and returns the page it opens. */
export async function open(hub: Page, app: App, launch: Launch): Promise<Page> {
  const link = hub.locator(`a[data-app="${app}"][data-path="${launch.path}"]`);
  const [page] = await Promise.all([
    hub.context().waitForEvent("page"),
    link.click(),
  ]);
  return page;
}

export async function expectData(page: Page, launch: Launch): Promise<void> {
  await expect(page.getByTestId(launch.ready.testId)).toHaveText(
    launch.ready.text,
  );
  await expect(page.getByTestId(launch.data.testId)).toHaveText(
    launch.data.text,
  );
  await expect(page.locator("canvas").first()).toBeVisible();
}

/** The app's first launch in the catalog. */
export function firstLaunch(app: App): Launch {
  const [launch] = catalog.find((entry) => entry.app === app)?.launches ?? [];
  if (launch === undefined) throw new Error(`${app} has no launch`);
  return launch;
}

export async function press(
  hub: Page,
  app: App,
  control: string,
): Promise<void> {
  await hub
    .locator(`button[data-app="${app}"][data-control="${control}"]`)
    .click();
}

/** One test per launch of the apps `which` selects. */
export function launchTests(which: (app: App) => boolean): void {
  for (const entry of catalog.filter((entry) => which(entry.app))) {
    for (const launch of entry.launches) {
      test(`${entry.app} ${launch.path} opens from the hub and draws data`, async ({
        page: hub,
      }) => {
        await hub.goto("/");
        const page = await open(hub, entry.app, launch);
        await expectData(page, launch);
        // The panel reads the app's backend: what the page drew was fetched.
        await expect
          .poll(() => count(hub, entry.app, "fetches"))
          .toBeGreaterThan(0);
      });
    }
  }
}
