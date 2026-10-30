import { expect, type Page, test } from "@playwright/test";
import { catalog, type Launch } from "../../scripts/demo/catalog";
import { type App, apps } from "../examples/apps";

// The demo hub (`bun run demo`, scripts/demo.ts): it links every example
// app and reference client, each link opens a page that draws data from
// its backend, and the panel shows and drives each app's mock backend.
// Playwright starts the demo with --reuse-builds after the example specs'
// servers, on ports of its own (scripts/demo/catalog.ts).

/** A table cell of the backends panel. */
function cell(hub: Page, app: App, field: string) {
  return hub.locator(`tr[data-app="${app}"] td[data-field="${field}"]`);
}

async function count(hub: Page, app: App, field: string): Promise<number> {
  return Number(await cell(hub, app, field).textContent());
}

/** Clicks the hub's link to the launch, and returns the page it opens. */
async function open(hub: Page, app: App, launch: Launch): Promise<Page> {
  const link = hub.locator(`a[data-app="${app}"][data-path="${launch.path}"]`);
  const [page] = await Promise.all([
    hub.context().waitForEvent("page"),
    link.click(),
  ]);
  return page;
}

async function expectData(page: Page, launch: Launch): Promise<void> {
  await expect(page.getByTestId(launch.ready.testId)).toHaveText(
    launch.ready.text,
  );
  await expect(page.getByTestId(launch.data.testId)).toHaveText(
    launch.data.text,
  );
  await expect(page.locator("canvas").first()).toBeVisible();
}

test("the hub links every page of every app, and nothing else", async ({
  page,
}) => {
  await page.goto("/");
  const links = await page
    .locator("a[data-app]")
    .evaluateAll((anchors) =>
      anchors.map(
        (a) => `${a.getAttribute("data-app")} ${a.getAttribute("data-path")}`,
      ),
    );
  const listed = catalog.flatMap((entry) =>
    entry.launches.map((launch) => `${entry.app} ${launch.path}`),
  );
  expect(links.sort()).toEqual(listed.sort());
  // A new app under examples/ or reference/ must be added to the hub too.
  expect(new Set(catalog.map((entry) => entry.app))).toEqual(
    new Set(Object.keys(apps)),
  );
});

for (const entry of catalog) {
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

test("the panel's Expire token makes an open page refresh its token", async ({
  page: hub,
}) => {
  const app = "react-lwcharts";
  const [launch] = catalog.find((entry) => entry.app === app)?.launches ?? [];
  if (launch === undefined) throw new Error(`${app} has no launch`);
  await hub.goto("/");
  const page = await open(hub, app, launch);
  await expectData(page, launch);
  await expect(cell(hub, app, "refreshes")).toHaveText(/^\d+$/);
  const before = await count(hub, app, "refreshes");
  await hub
    .locator(`button[data-app="${app}"][data-control="expireAccess"]`)
    .click();
  // The page polls every five seconds; its next fetch is refused, and it
  // rotates the tokens once.
  await expect
    .poll(() => count(hub, app, "refreshes"), { timeout: 15_000 })
    .toBeGreaterThan(before);
  await expect(page.getByTestId("auth")).toHaveText("ok");
});
