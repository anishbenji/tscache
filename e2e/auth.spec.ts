import {
  cacheConfig,
  connect,
  drainEvents,
  expect,
  installRefresh,
  lockQueue,
  open,
  read,
  refreshScenario,
  sessionLost,
  test,
  updateAuth,
  updateCount,
} from "./support";

// authInvalid across tabs (§2.5, §4.9, designs b and y): one refused token
// is broadcast to every tab, gets come back auth-pending without fetching
// while auth is invalid, and any tab's updateAuth recovers every tab. The
// backend's expire replaces the access token only, so the refresh token
// still works.

test("one tab refreshes behind a Web Lock while the others wait", async ({
  context,
  backend,
}) => {
  const config = cacheConfig();
  const a = await open(context);
  const b = await open(context);
  const c = await open(context);
  const pages = [a, b, c];
  for (const page of pages) {
    await connect(page, backend.clientOptions());
    await installRefresh(page, backend.ns);
  }
  await backend.control({ expire: true, hold: { refresh: 1 } });
  expect(await read(a, config, { start: 3, end: 33 })).toEqual({
    timestamps: [],
    volume: [],
    coverage: [],
    misses: [{ range: { start: 3, end: 33 }, reason: "auth-pending" }],
  });
  // Every tab hears which context was refused (N33).
  for (const page of pages) {
    expect(await drainEvents(page, config, "authInvalid")).toEqual([
      {
        error: {
          name: "AuthInvalidError",
          message: "candles refused the access token",
        },
        context: { ns: backend.ns, token: "at-0" },
      },
    ]);
  }
  // One tab's refresh is held at the backend while it holds the lock; the
  // other two queue behind it instead of spending the same refresh token.
  await backend.waitHeld("refresh", 1);
  await expect
    .poll(() => lockQueue(a, "tscache-auth-refresh"))
    .toEqual({ held: 1, pending: 2 });
  await backend.release("refresh");
  for (const page of pages) await expect.poll(() => updateCount(page)).toBe(1);
  for (const page of pages) expect(await sessionLost(page)).toEqual([]);
  expect(await backend.state()).toMatchObject({ refreshes: 1, reused: 0 });
  const reads = [
    { page: a, range: { start: 3, end: 33 } },
    { page: b, range: { start: 103, end: 133 } },
    { page: c, range: { start: 203, end: 233 } },
  ];
  for (const { page, range } of reads) {
    const got = await read(page, config, range);
    expect(got.coverage).toEqual([range]);
    expect(got.misses).toEqual([]);
  }
  expect((await backend.state()).requests).toEqual({
    "3-33": 2,
    "103-133": 1,
    "203-233": 1,
  });
});

test("any tab's updateAuth recovers every tab", async ({
  context,
  backend,
}) => {
  const config = cacheConfig();
  const a = await open(context);
  const b = await open(context);
  await connect(a, backend.clientOptions());
  await connect(b, backend.clientOptions());
  await backend.control({ expire: true });
  expect((await read(a, config, { start: 3, end: 33 })).misses).toEqual([
    { range: { start: 3, end: 33 }, reason: "auth-pending" },
  ]);
  // While auth is invalid no tab fetches: B's miss comes back at once.
  expect((await read(b, config, { start: 43, end: 63 })).misses).toEqual([
    { range: { start: 43, end: 63 }, reason: "auth-pending" },
  ]);
  expect((await backend.state()).requests).toEqual({ "3-33": 1 });
  const { access } = await backend.refresh("rt-0");
  await updateAuth(b, { ns: backend.ns, token: access });
  expect(await read(a, config, { start: 3, end: 33 })).toEqual({
    timestamps: [3, 13, 23, 33],
    volume: [2, 2, 2, 2],
    coverage: [{ start: 3, end: 33 }],
    misses: [],
  });
});

// The snippet on its own, with stand-in clients (pages/refresh-harness.js):
// event orders a real port can produce, and storage failures. Each event
// names the refused token, so only a refusal of the stored one refreshes.

test("queued stale events adopt the current tokens", async ({ context }) => {
  const page = await open(context);
  expect(await refreshScenario(page, "queuedStaleEvents")).toEqual({
    refreshed: ["rt-2"],
    updates: ["a:at-2", "a:at-2", "a:at-x1"],
    lost: [],
  });
});

test("a refusal during a recovery's update is acted on", async ({
  context,
}) => {
  const page = await open(context);
  expect(await refreshScenario(page, "refusalDuringUpdate")).toEqual({
    refreshed: ["rt-0", "rt-x1"],
    updates: ["a:at-x1", "a:at-x2"],
    lost: [],
  });
});

test("a late event about a replaced token rotates nothing", async ({
  context,
}) => {
  const page = await open(context);
  expect(await refreshScenario(page, "lateStaleEvent")).toEqual({
    refreshed: ["rt-0"],
    updates: ["a:at-x1", "a:at-x1"],
    lost: [],
  });
});

test("two tabs hearing one refusal refresh once", async ({ context }) => {
  const page = await open(context);
  expect(await refreshScenario(page, "twoTabsOneRefusal")).toEqual({
    refreshed: ["rt-0"],
    updates: ["a:at-x1", "b:at-x1"],
    lost: [],
  });
});

test("a failed save ends the session instead of reusing the token", async ({
  context,
}) => {
  const page = await open(context);
  expect(await refreshScenario(page, "saveFailsAfterRefresh")).toEqual({
    refreshed: ["rt-0"],
    updates: [],
    lost: ["a", "b"],
    stored: { access: "at-0", refresh: null },
  });
});

test("without storage the refresh token is never spent", async ({
  context,
}) => {
  const page = await open(context);
  expect(await refreshScenario(page, "storageUnavailable")).toEqual({
    refreshed: [],
    updates: [],
    lost: ["a"],
    stored: { access: "at-0", refresh: "rt-0" },
  });
});
