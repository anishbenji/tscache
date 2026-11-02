import {
  cacheConfig,
  clearAll,
  connect,
  expect,
  open,
  read,
  settle,
  start,
  stored,
  test,
} from "./support";

// IndexedDB persistence in the SharedWorker hosting (architecture §4.10,
// slice (a)). A reload is a page whose client uses another worker URL: a
// SharedWorker is keyed by its URL, so that page gets a new worker, whose
// engine knows nothing and loads from the disk, while the first worker's
// memory stays out of reach. Each test has a fresh browser context, so a
// fresh database.

/** The same worker script under another URL: a new SharedWorker. */
const reloaded = "/dist/worker.js?session=2";

const bars = { start: 3, end: 63 };
const all = [3, 13, 23, 33, 43, 53, 63];

test("a reload reads its bars from IndexedDB without a fetch", async ({
  context,
  backend,
}) => {
  const config = cacheConfig({ persist: true });
  const a = await open(context);
  expect((await connect(a, backend.clientOptions())).mode).toBe("shared");
  expect((await read(a, config, bars)).misses).toEqual([]);
  // Written behind, after the quiet spell.
  await expect
    .poll(() => stored(a, config.id))
    .toEqual({ caches: 1, pages: 1 });
  const b = await open(context);
  const options = { ...backend.clientOptions(), workerUrl: reloaded };
  expect((await connect(b, options)).mode).toBe("shared");
  expect(await read(b, config, bars)).toEqual({
    timestamps: all,
    volume: all.map(() => 1),
    coverage: [bars],
    misses: [],
  });
  expect((await backend.state()).requests).toEqual({ "3-63": 1 });
});

test("the provisional tail is fetched again after a reload", async ({
  context,
  backend,
}) => {
  // Points at 33 and after are provisional: never covered, never stored.
  const config = cacheConfig({ persist: true, finalizedUntil: 33 });
  const a = await open(context);
  await connect(a, backend.clientOptions());
  await read(a, config, bars);
  await expect
    .poll(() => stored(a, config.id))
    .toEqual({ caches: 1, pages: 1 });
  const b = await open(context);
  await connect(b, { ...backend.clientOptions(), workerUrl: reloaded });
  const got = await read(b, config, bars);
  expect(got.timestamps).toEqual(all);
  const requests = (await backend.state()).requests;
  // The stored bars are not asked for again; the tail is.
  expect(requests["3-63"]).toBe(1);
  const later = Object.keys(requests).filter((range) => range !== "3-63");
  expect(later).toHaveLength(1);
  expect(Number(later[0]?.split("-")[0])).toBeGreaterThanOrEqual(23);
});

test("after clearAll resolves, both stores are empty", async ({
  context,
  backend,
}) => {
  const first = cacheConfig({ persist: true });
  const second = cacheConfig({ persist: true });
  const a = await open(context);
  await connect(a, backend.clientOptions());
  await read(a, first, bars);
  await read(a, second, bars);
  await expect.poll(() => stored(a)).toEqual({ caches: 2, pages: 2 });
  await clearAll(a);
  expect(await stored(a)).toEqual({ caches: 0, pages: 0 });
});

// A dedicated-worker or in-process page persists nothing, but its clearAll
// empties the database too, so what a SharedWorker session stored cannot
// come back after a logout from any hosting (§4.10.7, N66).
for (const mode of ["dedicated", "in-process"] as const) {
  test(`clearAll from a page hosted ${mode} empties what the SharedWorker stored; a reload fetches again`, async ({
    context,
    backend,
  }) => {
    const config = cacheConfig({ persist: true });
    const a = await open(context);
    expect((await connect(a, backend.clientOptions())).mode).toBe("shared");
    await read(a, config, bars);
    await expect
      .poll(() => stored(a, config.id))
      .toEqual({ caches: 1, pages: 1 });
    const b = await open(context);
    expect((await connect(b, { ...backend.clientOptions(), mode })).mode).toBe(
      mode,
    );
    await clearAll(b);
    expect(await stored(b)).toEqual({ caches: 0, pages: 0 });
    const c = await open(context);
    await connect(c, { ...backend.clientOptions(), workerUrl: reloaded });
    expect((await read(c, config, bars)).misses).toEqual([]);
    expect((await backend.state()).requests).toEqual({ "3-63": 2 });
  });

  test(`clearAll from a page hosted ${mode} creates no database`, async ({
    context,
    backend,
  }) => {
    const b = await open(context);
    expect((await connect(b, { ...backend.clientOptions(), mode })).mode).toBe(
      mode,
    );
    await clearAll(b);
    expect(await stored(b)).toBeUndefined();
  });
}

test("a reload whose config names another version fetches again", async ({
  context,
  backend,
}) => {
  const config = cacheConfig({ persist: true, version: "v1" });
  const a = await open(context);
  await connect(a, backend.clientOptions());
  await read(a, config, bars);
  await expect
    .poll(() => stored(a, config.id))
    .toEqual({ caches: 1, pages: 1 });
  await backend.control({ version: "v2" });
  const b = await open(context);
  await connect(b, { ...backend.clientOptions(), workerUrl: reloaded });
  const got = await read(b, { ...config, version: "v2" }, bars);
  expect(got.misses).toEqual([]);
  expect((await backend.state()).requests).toEqual({ "3-63": 2 });
});

test("a second tab's cache() waits for the first tab's load, then reads without a fetch", async ({
  context,
  backend,
}) => {
  const config = cacheConfig({ persist: true });
  const a = await open(context);
  await connect(a, backend.clientOptions());
  await read(a, config, bars);
  await expect
    .poll(() => stored(a, config.id))
    .toEqual({ caches: 1, pages: 1 });
  const options = { ...backend.clientOptions(), workerUrl: reloaded };
  const b = await open(context);
  const c = await open(context);
  await connect(b, options);
  await connect(c, options);
  // Both tabs open the cache at once on the new worker: one load serves both.
  await start(b, "b", config, bars);
  await start(c, "c", config, bars);
  for (const [page, key] of [
    [b, "b"],
    [c, "c"],
  ] as const) {
    expect((await settle(page, key)).misses).toEqual([]);
  }
  expect((await backend.state()).requests).toEqual({ "3-63": 1 });
});
