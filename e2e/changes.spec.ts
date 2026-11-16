import {
  cacheConfig,
  connect,
  expect,
  follow,
  followed,
  open,
  put,
  read,
  test,
} from "./support";

// Change events across tabs (architecture §2.7, N71-N84; tests 20 and
// 22-24 of docs/design/m7-change-events.md §5). The pages of one
// BrowserContext share one SharedWorker. Each view follows the read rule
// (N84) through `follow`; `followed` waits for a round trip and for every
// read the view started, so fetch counts are read after the last reaction.

const range = { start: 3, end: 53 };

/** Every candles request the backend has seen. */
function total(requests: Record<string, number>): number {
  return Object.values(requests).reduce((sum, n) => sum + n, 0);
}

test("a put in one tab reaches the other's cache.on, and its cacheOnly read shows it without a fetch", async ({
  context,
  backend,
}) => {
  const config = cacheConfig();
  const a = await open(context);
  const b = await open(context);
  expect((await connect(a, backend.clientOptions())).mode).toBe("shared");
  expect((await connect(b, backend.clientOptions())).mode).toBe("shared");
  await follow(b, "view", config, range, "cacheOnly");
  await put(a, config, [13]);
  const seen = await followed(b, "view", config);
  expect(seen.events).toEqual([
    {
      cacheId: config.id,
      written: [{ start: 13, end: 13 }],
      removed: [],
      cleared: false,
      requestId: expect.any(String),
    },
  ]);
  expect(seen.last?.timestamps).toEqual([13]);
  expect(seen).toMatchObject({ fetching: 0, cacheOnly: 2 });
  expect((await backend.state()).requests).toEqual({});
});

test("the loop guard: feed bars in the volatile tail cause no fetch in either tab", async ({
  context,
  backend,
}) => {
  const config = cacheConfig({ finalizedUntil: 33 });
  const a = await open(context);
  const b = await open(context);
  for (const page of [a, b]) {
    expect((await connect(page, backend.clientOptions())).mode).toBe("shared");
  }
  // Each first read fetches the tail, once or twice depending on whether
  // they overlap in flight: count after both have settled.
  await follow(a, "view", config, range, "fetching");
  await follow(b, "view", config, range, "fetching");
  const first = [
    await followed(a, "view", config),
    await followed(b, "view", config),
  ];
  const fetched = total((await backend.state()).requests);
  expect(fetched).toBeGreaterThan(0);

  const bars = 5;
  for (let i = 0; i < bars; i++) await put(a, config, [53]);
  for (const [i, page] of [a, b].entries()) {
    const seen = await followed(page, "view", config);
    expect(seen.events).toHaveLength((first[i]?.events.length ?? 0) + bars);
    expect(seen.fetching).toBe(1);
    expect(seen.last?.timestamps).toContain(53);
  }
  expect(total((await backend.state()).requests)).toBe(fetched);
});

test("alternating dataset versions: one get costs at most N29's two rounds, and nothing after it", async ({
  context,
  backend,
}) => {
  const config = cacheConfig({ version: "v0" });
  await backend.control({ alternate: ["v1", "v2"] });
  const a = await open(context);
  const b = await open(context);
  for (const page of [a, b]) {
    expect((await connect(page, backend.clientOptions())).mode).toBe("shared");
  }
  await follow(a, "view", config, range, "cacheOnly");
  await follow(b, "view", config, range, "cacheOnly");
  const got = await read(a, config, range);
  expect(got.misses).toEqual([]);
  const views = [
    await followed(a, "view", config),
    await followed(b, "view", config),
  ];
  const fetched = total((await backend.state()).requests);
  expect(fetched).toBeGreaterThan(0);
  expect(fetched).toBeLessThanOrEqual(2);
  for (const seen of views) {
    // The fetch's version cleared the cache and wrote: cacheOnly only.
    expect(seen.events.some((event) => event.cleared)).toBe(true);
    expect(seen.events.every((event) => event.written.length > 0)).toBe(true);
    expect(seen.fetching).toBe(0);
  }
  expect(total((await backend.state()).requests)).toBe(fetched);
});

test("dedicated workers: a tab hears its own changes and no other tab's", async ({
  context,
  backend,
}) => {
  const config = cacheConfig();
  const a = await open(context);
  const b = await open(context);
  for (const page of [a, b]) {
    const options = { ...backend.clientOptions(), mode: "dedicated" as const };
    expect((await connect(page, options)).mode).toBe("dedicated");
  }
  await follow(a, "view", config, range, "cacheOnly");
  await follow(b, "view", config, range, "cacheOnly");
  await put(a, config, [13]);
  expect((await followed(a, "view", config)).events).toHaveLength(1);
  expect((await followed(b, "view", config)).events).toEqual([]);
});
