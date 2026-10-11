import {
  cacheConfig,
  cacheFailure,
  connect,
  expect,
  failure,
  heard,
  open,
  read,
  start,
  test,
} from "./support";

// Loss of the SharedWorker (§4.8, N32). Chromium runs a SharedWorker in the
// renderer of the tab that created it, so a crash of that renderer kills the
// worker and nothing reaches the other tabs. The worker holds a Web Lock for
// its lifetime and the clients queue on it: the grant tells the survivor its
// worker is gone, so its calls reject and workerLost fires instead of every
// call hanging.

const range = { start: 3, end: 33 };
const reason = "SharedWorker stopped running (its lifetime lock was released)";

test("the host tab crashing rejects the survivor's calls and fires workerLost", async ({
  context,
  backend,
}) => {
  const config = cacheConfig();
  // The first tab to connect creates the worker, in its own renderer.
  const host = await open(context);
  await connect(host, backend.clientOptions());
  const survivor = await open(context);
  await connect(survivor, backend.clientOptions());
  await backend.control({ hold: { candles: 1 } });
  await start(survivor, "s", config, range);
  await backend.waitHeld("candles", 1);
  const dead = host.waitForEvent("crash");
  const cdp = await context.newCDPSession(host);
  // The target dies before it can answer.
  cdp.send("Page.crash").catch(() => {});
  await dead;
  // The get waiting on the dead worker's fetch rejects instead of hanging.
  expect(await failure(survivor, "s")).toEqual({
    name: "TscacheError",
    message: reason,
  });
  expect(await heard(survivor, "workerLost")).toEqual([{ reason }]);
  // Later calls reject at once.
  expect(await cacheFailure(survivor, config)).toEqual({
    name: "TscacheError",
    message: reason,
  });
  expect(await heard(survivor, "workerLost")).toEqual([{ reason }]);
  await backend.release("candles");
  // The app creates a new client, which starts a new worker in this tab.
  expect(await connect(survivor, backend.clientOptions())).toEqual({
    mode: "shared",
    fallbacks: [],
  });
  expect(await read(survivor, config, range)).toEqual({
    timestamps: [3, 13, 23, 33],
    volume: [2, 2, 2, 2],
    coverage: [range],
    misses: [],
  });
  expect((await backend.state()).requests).toEqual({ "3-33": 2 });
});
