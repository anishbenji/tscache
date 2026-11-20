import {
  cacheConfig,
  connect,
  expect,
  memoryStats,
  open,
  read,
  stored,
  test,
} from "./support";

// Memory budgets in the browser (architecture §2.9, N86-N105; tests 20 and
// 21 of docs/design/m3-memory.md §5). The pages of one BrowserContext share
// one SharedWorker, so one engine and one budget. With a slot cap of 4 a
// page of these caches (price f64, volume i16) holds 4 × 10 bytes of fields
// and a 1-byte mask: 41 bytes, and the budget below holds two pages.

const page = 4 * 10 + 1;
const budget = 2 * page;
/** Slots 0-7: pages 0 and 1 of the suites' grid (interval 10, offset 3). */
const early = { start: 3, end: 73 };
/** Slots 8-15: pages 2 and 3. */
const later = { start: 83, end: 153 };

/** The same worker script under another URL: a new SharedWorker. */
const reloaded = "/dist/worker.js?session=2";

test("two tabs share one budget: tab A's reads evict tab B's older pages, which B then fetches again", async ({
  context,
  backend,
}) => {
  const ofA = cacheConfig({ segmentSlotCap: 4 });
  const ofB = cacheConfig({ segmentSlotCap: 4 });
  const a = await open(context);
  const b = await open(context);
  for (const tab of [a, b]) {
    const options = { ...backend.clientOptions(), memoryBudget: budget };
    expect((await connect(tab, options)).mode).toBe("shared");
  }
  expect((await read(b, ofB, early)).misses).toEqual([]);
  expect((await read(a, ofA, later)).misses).toEqual([]);
  // B's pages were the least recently used: both went for A's two.
  const stats = await memoryStats(a);
  expect(stats).toMatchObject({
    budget,
    bytes: budget,
    pinnedBytes: 0,
    evictedPages: 2,
  });
  expect(
    Object.fromEntries(stats.caches.map((c) => [c.cacheId, c.pages])),
  ).toEqual({ [ofA.id]: 2, [ofB.id]: 0 });
  expect(await memoryStats(b)).toEqual(stats);
  // B's next read over its range fetches it again, once.
  const again = await read(b, ofB, early);
  expect(again.misses).toEqual([]);
  expect(again.timestamps).toEqual([3, 13, 23, 33, 43, 53, 63, 73]);
  const { requests } = await backend.state();
  expect(requests).toEqual({ "3-73": 2, "83-153": 1 });
  expect(await memoryStats(b)).toMatchObject({
    bytes: budget,
    evictedPages: 4,
  });
  expect(await memoryStats(a)).toEqual(await memoryStats(b));
});

test("a persisted cache under a budget: after a reload the evicted pages are fetched and the resident ones load from disk", async ({
  context,
  backend,
}) => {
  const config = cacheConfig({ persist: true, segmentSlotCap: 4 });
  const a = await open(context);
  await connect(a, { ...backend.clientOptions(), memoryBudget: budget });
  await read(a, config, early);
  await read(a, config, later);
  expect(await memoryStats(a)).toMatchObject({
    bytes: budget,
    evictedPages: 2,
  });
  // The flush deleted the evicted pages' records (N95): two pages stay.
  await expect
    .poll(() => stored(a, config.id))
    .toEqual({ caches: 1, pages: 2 });
  const b = await open(context);
  await connect(b, {
    ...backend.clientOptions(),
    workerUrl: reloaded,
    memoryBudget: budget,
  });
  // The flank rule (N63) asks for the second range from slot 7 on.
  const before = (await backend.state()).requests;
  expect(before).toEqual({ "3-73": 1, "73-153": 1 });
  expect((await read(b, config, later)).misses).toEqual([]);
  expect((await backend.state()).requests).toEqual(before);
  const fetched = await read(b, config, early);
  expect(fetched.timestamps).toEqual([3, 13, 23, 33, 43, 53, 63, 73]);
  // Pages 0 and 1 again, with one slot into the resident coverage.
  expect((await backend.state()).requests).toEqual({ ...before, "3-83": 1 });
});
