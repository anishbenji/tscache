import { expect, test } from "@playwright/test";
import { NOTICE_CHANNEL } from "../../examples/mock-backend/src/notices";
import { catalog } from "../../scripts/demo/catalog";
import { apps } from "../examples/apps";
import {
  expectData,
  firstLaunch,
  launchTests,
  open,
  press,
  SHARED_STATE,
} from "./support";

// The demo hub (`bun run demo`, scripts/demo.ts): it links every example
// app and reference client, each link opens a page that draws data from
// its backend, and the panel shows and drives each app's mock backend.
// Playwright starts the demo with --reuse-builds after the example specs'
// servers, on ports of its own (scripts/demo/catalog.ts). The apps with
// shared backend state are tested in shared.spec.ts.

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

launchTests((app) => !SHARED_STATE.has(app));

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
