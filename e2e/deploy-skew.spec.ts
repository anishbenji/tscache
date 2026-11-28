import {
  cacheConfig,
  clearAll,
  connect,
  drainEvents,
  expect,
  featuresOf,
  follow,
  followed,
  heard,
  memoryStats,
  nextLibrary,
  nextWorkerUrl,
  open,
  openNext,
  put,
  read,
  roundTrip,
  secondFetcher,
  stored,
  storedPages,
  supersededOf,
  test,
  workerUrl,
} from "./support";

// Deploy skew in the browser (architecture §2.7, §4.7, §4.10.7; N125-N141;
// tests 18-24, 33 and 34 of docs/design/m5-deploy-skew.md §6). The pages of
// one BrowserContext are the tabs of one origin: they share SharedWorkers,
// the database and the workers' BroadcastChannel, and each test has a fresh
// context. Two generations need no second build: the fetcher's URL is part
// of the generation key, the worker's URL names its build, and the e2e
// server also serves the package as a later library version
// (scripts/e2e-server.ts).
//
// Persisted caches use a slot cap of 4, so with the suites' grid (interval
// 10, offset 3) page p holds the timestamps 3 + 40p to 33 + 40p.

/** A SharedWorker's library version as its page's client has it. */
const library = expect.stringMatching(/^\d+\.\d+\.\d+/);

/** The same worker script under another URL: another build of the worker. */
const otherBuild = `${workerUrl}?build=b`;

const bars = { start: 3, end: 33 };
const all = [3, 13, 23, 33];

test("18: tabs with different fetcher URLs both connect, each to a worker of its own, and the earlier one is superseded", async ({
  context,
  backend,
}) => {
  const config = cacheConfig();
  const a = await open(context);
  const b = await open(context);
  expect((await connect(a, backend.clientOptions())).mode).toBe("shared");
  // Before step 135 this tab was refused with ConfigError.
  const second = await connect(
    b,
    backend.clientOptions(undefined, secondFetcher),
  );
  expect(second.mode).toBe("shared");
  // Each get is answered by its own worker: the second worker holds nothing
  // of the first one's cache, so it asks the backend again (volume counts
  // the requests for the range).
  expect((await read(a, config, bars)).volume).toEqual([1, 1, 1, 1]);
  expect((await read(b, config, bars)).volume).toEqual([2, 2, 2, 2]);

  // B started later, with the same library: A is superseded, B is not.
  await expect.poll(() => supersededOf(a)).toEqual({ lib: library });
  expect(await heard(a, "superseded")).toEqual([{ lib: library }]);
  await roundTrip(b, config);
  expect(await supersededOf(b)).toBeUndefined();
  expect(await heard(b, "superseded")).toEqual([]);
  for (const tab of [a, b]) {
    expect(await featuresOf(tab)).toEqual([
      "cacheChanged",
      "calendar-grid",
      "memoryBudget",
      "superseded",
    ]);
  }
  // The superseded tab keeps working from memory and its fetcher.
  expect((await read(a, config, bars, { cacheOnly: true })).timestamps).toEqual(
    all,
  );
});

test("19: two worker builds with one key are two workers, and the earlier one is superseded", async ({
  context,
  backend,
}) => {
  const config = cacheConfig();
  const a = await open(context);
  const b = await open(context);
  await connect(a, backend.clientOptions());
  await connect(b, { ...backend.clientOptions(), workerUrl: otherBuild });
  await put(a, config, [3]);
  // Two workers: B's holds nothing of what A put.
  expect((await read(b, config, bars, { cacheOnly: true })).timestamps).toEqual(
    [],
  );
  await expect.poll(() => supersededOf(a)).toEqual({ lib: library });
  await roundTrip(b, config);
  expect(await supersededOf(b)).toBeUndefined();
});

test("20: after a worker is superseded only the current one writes the database", async ({
  context,
  backend,
}) => {
  const config = cacheConfig({ persist: true, segmentSlotCap: 4 });
  const a = await open(context);
  await connect(a, backend.clientOptions());
  await put(a, config, [3]);
  await expect.poll(() => storedPages(a, config.id)).toEqual([0]);

  const b = await open(context);
  await connect(b, backend.clientOptions(undefined, secondFetcher));
  // B's worker loads the page A's wrote.
  expect((await read(b, config, bars, { cacheOnly: true })).timestamps).toEqual(
    [3],
  );
  await expect.poll(() => supersededOf(a)).toEqual({ lib: library });
  expect(await drainEvents(a, config, "persistStopped")).toEqual([
    { cacheId: config.id, reason: "superseded" },
  ]);

  // A puts into two further pages, which B never writes.
  await put(a, config, [43, 83]);
  // B writes a page of its own, and once that is stored another one. A
  // flush of A's, were one to run, would have been due before B's first
  // and at least one debounce before B's second.
  await put(b, config, [123]);
  await expect.poll(() => storedPages(b, config.id)).toEqual([0, 3]);
  await put(b, config, [163]);
  await expect.poll(() => storedPages(b, config.id)).toEqual([0, 3, 4]);
  // A still answers from its memory, which holds what it put.
  const held = await read(
    a,
    config,
    { start: 3, end: 83 },
    { cacheOnly: true },
  );
  expect(held.timestamps).toEqual([3, 43, 83]);
});

test("21: a logout in one generation's tab clears the other's memory and the disk", async ({
  context,
  backend,
}) => {
  const config = cacheConfig({ persist: true, segmentSlotCap: 4 });
  const a = await open(context);
  await connect(a, backend.clientOptions());
  expect((await read(a, config, bars)).volume).toEqual([1, 1, 1, 1]);
  await expect
    .poll(() => stored(a, config.id))
    .toEqual({ caches: 1, pages: 1 });
  const b = await open(context);
  await connect(b, backend.clientOptions(undefined, secondFetcher));
  expect((await read(b, config, bars, { cacheOnly: true })).timestamps).toEqual(
    all,
  );
  await expect.poll(() => supersededOf(a)).toEqual({ lib: library });

  await clearAll(b);
  // Once clearAll has resolved in tab B the database holds no record.
  expect(await stored(b)).toEqual({ caches: 0, pages: 0 });
  // A's worker cleared once for each of B's two posts (§4.10.7).
  const ofCache = async () =>
    (await heard(a, "cacheCleared")).filter((e) => e.cacheId === config.id);
  await expect.poll(async () => (await ofCache()).length).toBe(2);
  expect(await drainEvents(a, config, "cacheCleared")).toEqual([
    { cacheId: config.id, reason: "clear-all" },
    { cacheId: config.id, reason: "clear-all" },
  ]);
  // And it still holds none after A's worker has cleared too.
  expect(await stored(a)).toEqual({ caches: 0, pages: 0 });
  // A's memory went with it: its next get fetches again.
  expect((await read(a, config, bars)).volume).toEqual([2, 2, 2, 2]);
  expect((await backend.state()).requests).toEqual({ "3-33": 2 });
});

test("22: tabs with one key share a worker, and a tab without a fetcher beside them supersedes nobody", async ({
  context,
  backend,
}) => {
  const config = cacheConfig();
  const a = await open(context);
  const b = await open(context);
  const bare = await open(context);
  await connect(a, backend.clientOptions());
  await connect(b, backend.clientOptions());
  expect((await connect(bare, { workerUrl })).mode).toBe("shared");

  // One worker for A and B: a view in B hears A's put, as before.
  await follow(b, "view", config, bars, "cacheOnly");
  await put(a, config, [3, 13]);
  const view = await followed(b, "view", config);
  expect(view.events).toHaveLength(1);
  expect(view.last?.timestamps).toEqual([3, 13]);
  // The tab without a fetcher has a worker of its own, and both answer.
  expect(
    (await read(bare, config, bars, { cacheOnly: true })).timestamps,
  ).toEqual([]);
  await put(bare, config, [23]);
  expect(
    (await read(bare, config, bars, { cacheOnly: true })).timestamps,
  ).toEqual([23]);
  expect((await read(a, config, bars, { cacheOnly: true })).timestamps).toEqual(
    [3, 13],
  );
  for (const tab of [a, b, bare]) {
    await roundTrip(tab, config);
    expect(await supersededOf(tab)).toBeUndefined();
  }

  // A later, ordered event: another fetcher's worker supersedes A's and
  // B's, which had by then heard every earlier announcement. The tab
  // without a fetcher is of that worker's generation and stays as it is.
  const other = await open(context);
  await connect(other, backend.clientOptions(undefined, secondFetcher));
  await expect.poll(() => supersededOf(a)).toEqual({ lib: library });
  await expect.poll(() => supersededOf(b)).toEqual({ lib: library });
  await roundTrip(bare, config);
  expect(await supersededOf(bare)).toBeUndefined();
  expect(await heard(a, "superseded")).toHaveLength(1);
});

test("23: a fetcher changed behind its URL keeps the running worker and its module; a new URL starts a worker", async ({
  context,
  backend,
}) => {
  const config = cacheConfig();
  const later = { start: 43, end: 73 };
  const module = backend.swappableFetcher;
  const a = await open(context);
  await connect(a, backend.clientOptions(undefined, module));
  expect((await read(a, config, bars)).volume).toEqual([1, 1, 1, 1]);

  // The deploy: new contents behind the same URL.
  await backend.control({ fetcher: "marked" });
  const b = await open(context);
  await connect(b, backend.clientOptions(undefined, module));
  // One worker: B reads what A fetched, and its own fetch is answered by
  // the module the worker loaded, which does not mark its answers.
  expect((await read(b, config, bars, { cacheOnly: true })).timestamps).toEqual(
    all,
  );
  expect((await read(b, config, later)).volume).toEqual([1, 1, 1, 1]);
  for (const tab of [a, b]) {
    await roundTrip(tab, config);
    expect(await supersededOf(tab)).toBeUndefined();
  }

  // A URL that changes with the contents starts a worker, which loads them.
  const c = await open(context);
  await connect(c, backend.clientOptions(undefined, `${module}?v=2`));
  expect((await read(c, config, bars)).volume).toEqual([-1, -1, -1, -1]);
  await expect.poll(() => supersededOf(a)).toEqual({ lib: library });
  await expect.poll(() => supersededOf(b)).toEqual({ lib: library });
  await roundTrip(c, config);
  expect(await supersededOf(c)).toBeUndefined();
});

test("24: the higher library version stays current when it starts later", async ({
  context,
  backend,
}) => {
  const config = cacheConfig();
  const old = await open(context);
  await connect(old, backend.clientOptions());
  const next = await openNext(context);
  const options = { ...backend.clientOptions(), workerUrl: nextWorkerUrl };
  expect((await connect(next, options)).mode).toBe("shared");
  await expect.poll(() => supersededOf(old)).toEqual({ lib: nextLibrary });
  await roundTrip(next, config);
  expect(await supersededOf(next)).toBeUndefined();
});

test("24: the higher library version stays current when it started first", async ({
  context,
  backend,
}) => {
  const config = cacheConfig();
  const next = await openNext(context);
  await connect(next, {
    ...backend.clientOptions(),
    workerUrl: nextWorkerUrl,
  });
  await roundTrip(next, config);
  // The lower library starts later and is superseded at once.
  const old = await open(context);
  await connect(old, backend.clientOptions());
  await expect.poll(() => supersededOf(old)).toEqual({ lib: nextLibrary });
  // The later, ordered event: by now the higher worker has compared itself
  // with the lower one, whose announce brought its answer.
  await roundTrip(next, config);
  expect(await supersededOf(next)).toBeUndefined();
  expect(await heard(next, "superseded")).toEqual([]);
});

test("33: two generations have a budget each, and a tab that joins the superseded worker meets its budget", async ({
  context,
  backend,
}) => {
  const a = await open(context);
  const b = await open(context);
  await connect(a, { ...backend.clientOptions(), memoryBudget: 1000 });
  await connect(b, {
    ...backend.clientOptions(undefined, secondFetcher),
    memoryBudget: 2000,
  });
  expect((await memoryStats(a)).budget).toBe(1000);
  expect((await memoryStats(b)).budget).toBe(2000);
  await expect.poll(() => supersededOf(a)).toEqual({ lib: library });
  // Superseding touches nothing in the engine: the budget stays.
  expect((await memoryStats(a)).budget).toBe(1000);

  // A third tab with A's key joins A's worker, superseded as it is: the
  // property is set when createClient resolves, and the budget is A's.
  const c = await open(context);
  const joined = await connect(c, {
    ...backend.clientOptions(),
    memoryBudget: 3000,
  });
  expect(joined.superseded).toEqual({ lib: library });
  expect(await heard(c, "superseded")).toEqual([{ lib: library }]);
  expect((await memoryStats(c)).budget).toBe(1000);
  expect((await memoryStats(b)).budget).toBe(2000);
});

test("34: views in both generations follow a logout: two cleared events each, and both end with fetched data", async ({
  context,
  backend,
}) => {
  const config = cacheConfig();
  const a = await open(context);
  const b = await open(context);
  await connect(a, backend.clientOptions());
  await connect(b, backend.clientOptions(undefined, secondFetcher));
  await expect.poll(() => supersededOf(a)).toEqual({ lib: library });
  await follow(a, "view", config, bars, "fetching");
  await follow(b, "view", config, bars, "fetching");

  await clearAll(b);
  // k + 1 clears with one other worker (§4.10.7; decision concern DC1 of
  // the proposal, option (a)): A's worker clears for each of B's two posts,
  // B's for its own call and for A's relay.
  const cleared = async (tab: typeof a) =>
    (await followed(tab, "view", config)).events.filter((e) => e.cleared);
  await expect.poll(async () => (await cleared(a)).length).toBe(2);
  await expect.poll(async () => (await cleared(b)).length).toBe(2);
  const inA = await cleared(a);
  const inB = await cleared(b);
  const bare = { cacheId: config.id, written: [], removed: [], cleared: true };
  // A's worker has no request for the clear: no requestId.
  expect(inA).toEqual([bare, bare]);
  // B hears its own call first, under its request's id, then A's relay.
  expect(inB).toEqual([{ ...bare, requestId: expect.any(String) }, bare]);
  // Each view read again with a fetching get, once for each event, and
  // both caches end holding the range again.
  for (const tab of [a, b]) {
    expect((await followed(tab, "view", config)).fetching).toBe(3);
    const shown = await read(tab, config, bars, { cacheOnly: true });
    expect(shown.timestamps).toEqual(all);
    expect(shown.misses).toEqual([]);
  }
});
