import { expect, test } from "@playwright/test";
import {
  cell,
  count,
  expectData,
  firstLaunch,
  launchTests,
  open,
  press,
  SHARED_STATE,
} from "./support";

// The demo hub's tests on apps whose backend state is shared by every
// browser context (SHARED_STATE in support.ts). The demo-shared project runs
// them one at a time, repeats included, so each test's page and controls are
// the only ones acting on that state while it runs.

launchTests((app) => SHARED_STATE.has(app));

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
  const app = "solid-uplot";
  await hub.goto("/");
  const version = cell(hub, app, "version");
  await expect(version).toHaveText(/^v\d+$/);
  const before = Number((await version.textContent())?.slice(1));
  await press(hub, app, "bumpVersion");
  await expect(version).toHaveText(`v${before + 1}`);
});
