import { expect, type Page, test } from "@playwright/test";
import { NOTICE_CHANNEL } from "../../examples/mock-backend/src/notices";
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

/** The app's first launch in the catalog. */
function firstLaunch(app: App): Launch {
  const [launch] = catalog.find((entry) => entry.app === app)?.launches ?? [];
  if (launch === undefined) throw new Error(`${app} has no launch`);
  return launch;
}

async function press(hub: Page, app: App, control: string): Promise<void> {
  await hub
    .locator(`button[data-app="${app}"][data-control="${control}"]`)
    .click();
}

test("the panel's Expire token makes an open page refresh its token", async ({
  page: hub,
}) => {
  const app = "react-lwcharts";
  const launch = firstLaunch(app);
  await hub.goto("/");
  const page = await open(hub, app, launch);
  await expectData(page, launch);
  await expect(cell(hub, app, "refreshes")).toHaveText(/^\d+$/);
  const before = await count(hub, app, "refreshes");
  await press(hub, app, "expireAccess");
  // The page polls every five seconds; its next fetch is refused, and it
  // rotates the tokens once.
  await expect
    .poll(() => count(hub, app, "refreshes"), { timeout: 15_000 })
    .toBeGreaterThan(before);
  await expect(page.getByTestId("auth")).toHaveText("ok");
});

test("the panel's Restate history moves the backend to a new data version", async ({
  page: hub,
}) => {
  // No other test restates this app's history.
  const app = "solid-uplot";
  await hub.goto("/");
  const version = cell(hub, app, "version");
  await expect(version).toHaveText(/^v\d+$/);
  const before = Number((await version.textContent())?.slice(1));
  await press(hub, app, "bumpVersion");
  await expect(version).toHaveText(`v${before + 1}`);
});

test("the panel's Drop streams makes an open page reopen its feed and mend it", async ({
  page: hub,
}) => {
  const app = "reference-vanilla";
  const launch = firstLaunch(app);
  await hub.goto("/");
  const page = await open(hub, app, launch);
  await expectData(page, launch);
  // Count this page's fetches from here on: notices reach only the tabs of
  // its origin in this browser context.
  await page.evaluate((channel) => {
    const seen = { count: 0 };
    Object.assign(window, { __seen: seen });
    new BroadcastChannel(channel).onmessage = () => {
      seen.count++;
    };
  }, NOTICE_CHANNEL);
  const fetches = () =>
    page.evaluate(
      () => (window as unknown as { __seen: { count: number } }).__seen.count,
    );
  // A pushed bar: the feed is open.
  const drawn = page.getByTestId("drawn");
  await expect(drawn).not.toHaveText((await drawn.textContent()) ?? "", {
    timeout: 5000,
  });
  const before = await fetches();
  await press(hub, app, "dropStreams");
  // The feed reconnects, and the page reads its newest bars with a fetch to
  // mend what the broken stream missed.
  await expect.poll(fetches).toBeGreaterThan(before);
  await expect(page.getByTestId("connection")).toHaveText("live");
});

test("the hub refuses an unknown app or control", async ({ page: hub }) => {
  const unknownApp = await hub.request.post("/control/no-such-app", {
    data: "dropStreams",
  });
  expect(unknownApp.status()).toBe(400);
  const unknownControl = await hub.request.post("/control/solid-uplot", {
    data: "resetClock",
  });
  expect(unknownControl.status()).toBe(400);
});
