import {
  cacheConfig,
  clear,
  connect,
  drainEvents,
  expect,
  expectWorkerAlive,
  heard,
  open,
  read,
  settle,
  settled,
  start,
  test,
} from "./support";

// Tabs that go away while a fetch they started is in flight (§4.8, N28): the
// SharedWorker finishes the fetch, applies it and keeps serving the others.
// Chromium runs a SharedWorker in the renderer of the tab that created it,
// the first to connect; a crash of that renderer kills the worker, which is
// worker-loss.spec.ts (N32). These tests never crash the first tab, and no
// survivor hears workerLost.

const range = { start: 3, end: 33 };
const fetched = {
  timestamps: [3, 13, 23, 33],
  volume: [1, 1, 1, 1],
  coverage: [range],
  misses: [],
};
const next = { start: 43, end: 63 };

test("a tab that crashes mid-fetch leaves the others served", async ({
  context,
  backend,
}) => {
  const config = cacheConfig();
  const h = await open(context);
  await connect(h, backend.clientOptions());
  const d = await open(context);
  await connect(d, backend.clientOptions());
  const s = await open(context);
  await connect(s, backend.clientOptions());
  const crashed: string[] = [];
  h.on("crash", () => crashed.push("h"));
  s.on("crash", () => crashed.push("s"));
  await backend.control({ hold: { candles: 1 } });
  await start(d, "d", config, range);
  await backend.waitHeld("candles", 1);
  await start(s, "s", config, range);
  // Port messages are ordered: this reply means the worker has taken S's get.
  await read(s, config, range, { cacheOnly: true });
  expect(await settled(s, "s")).toBe(false);
  const dead = d.waitForEvent("crash");
  const cdp = await context.newCDPSession(d);
  // The target dies before it can answer.
  cdp.send("Page.crash").catch(() => {});
  await dead;
  await expectWorkerAlive(s, config, range);
  await backend.release("candles");
  expect(await settle(s, "s")).toEqual(fetched);
  expect((await backend.state()).requests).toEqual({ "3-33": 1 });
  expect(await read(h, config, range, { cacheOnly: true })).toEqual(fetched);
  // The worker still broadcasts to every live tab, past the dead one's port.
  await clear(h, config);
  for (const page of [h, s]) {
    expect(await drainEvents(page, config, "cacheCleared")).toEqual([
      { cacheId: config.id, reason: "manual" },
    ]);
  }
  expect((await read(s, config, next)).misses).toEqual([]);
  expect((await backend.state()).requests).toEqual({ "3-33": 1, "43-63": 1 });
  expect(crashed).toEqual([]);
  for (const page of [h, s])
    expect(await heard(page, "workerLost")).toEqual([]);
});

test("the host tab closing mid-fetch leaves its fetch applied", async ({
  context,
  backend,
}) => {
  const config = cacheConfig();
  const h = await open(context);
  await connect(h, backend.clientOptions());
  const s = await open(context);
  await connect(s, backend.clientOptions());
  await backend.control({ hold: { candles: 1 } });
  await start(h, "h", config, range);
  await backend.waitHeld("candles", 1);
  await h.close();
  await expectWorkerAlive(s, config, range);
  await backend.release("candles");
  // Nobody waits on the fetch any more; the worker applies it on its own.
  await expect
    .poll(() => read(s, config, range, { cacheOnly: true }))
    .toEqual(fetched);
  expect((await backend.state()).requests).toEqual({ "3-33": 1 });
  // Abuts the applied range, so the flank point 33 is fetched with it.
  expect((await read(s, config, next)).misses).toEqual([]);
  expect((await backend.state()).requests).toEqual({ "3-33": 1, "33-63": 1 });
  expect(await heard(s, "workerLost")).toEqual([]);
});
