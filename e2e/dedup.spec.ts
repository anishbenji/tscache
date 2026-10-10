import {
  cacheConfig,
  connect,
  expect,
  open,
  read,
  settle,
  settled,
  start,
  test,
} from "./support";

// In-flight deduplication across tabs (§4.9, N31): the pages of one
// BrowserContext share one SharedWorker, where a get producing the same
// coalesced range as a fetch in flight awaits that fetch. The backend gate
// keeps the first fetch open, so the overlap is certain rather than timed.

const range = { start: 3, end: 33 };

test("two tabs share one fetch for the same range", async ({
  context,
  backend,
}) => {
  const config = cacheConfig();
  const a = await open(context);
  const b = await open(context);
  expect((await connect(a, backend.clientOptions())).mode).toBe("shared");
  expect((await connect(b, backend.clientOptions())).mode).toBe("shared");
  await backend.control({ hold: { candles: 1 } });
  await start(a, "a", config, range);
  await backend.waitHeld("candles", 1);
  await start(b, "b", config, range);
  // Port messages are ordered: this reply means the worker has taken B's get.
  await read(b, config, range, { cacheOnly: true });
  expect(await settled(b, "b")).toBe(false);
  await backend.release("candles");
  const got = await settle(a, "a");
  expect(got).toEqual({
    timestamps: [3, 13, 23, 33],
    volume: [1, 1, 1, 1],
    coverage: [range],
    misses: [],
  });
  expect(await settle(b, "b")).toEqual(got);
  // B stayed open only by waiting on a fetch; one request means it was A's.
  expect((await backend.state()).requests).toEqual({ "3-33": 1 });
});

test("pages of separate contexts fetch separately", async ({
  browser,
  backend,
}) => {
  // Control for the test above: the same steps across two contexts, which
  // share no worker, must show two fetches, or one fetch there proves nothing.
  const config = cacheConfig();
  const contexts = [await browser.newContext(), await browser.newContext()];
  try {
    const pages = await Promise.all(contexts.map((c) => open(c)));
    for (const page of pages) {
      expect((await connect(page, backend.clientOptions())).mode).toBe(
        "shared",
      );
    }
    await backend.control({ hold: { candles: 2 } });
    for (const page of pages) await start(page, "get", config, range);
    // Two fetches held at once: each context runs its own worker.
    await backend.waitHeld("candles", 2);
    await backend.release("candles");
    for (const page of pages) {
      expect((await settle(page, "get")).misses).toEqual([]);
    }
    expect((await backend.state()).requests).toEqual({ "3-33": 2 });
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});
