import {
  cacheConfig,
  connect,
  drainEvents,
  expect,
  open,
  read,
  settle,
  start,
  test,
} from "./support";

// Version-mismatch clears across tabs (§2.7, §4.5, N29). The cache is
// created with version v1, so a v2 answer is a mismatch (not a first
// version to adopt, N18): its put clears the cache for every tab, and an
// answer whose fetch started before that clear is dropped and fetched again.

const cleared = (cacheId: string) => ({
  cacheId,
  reason: "version-mismatch",
});

test("a version-mismatch clear reaches every tab", async ({
  context,
  backend,
}) => {
  const config = cacheConfig({ version: "v1" });
  const a = await open(context);
  const b = await open(context);
  await connect(a, backend.clientOptions());
  await connect(b, backend.clientOptions());
  expect((await read(a, config, { start: 3, end: 33 })).misses).toEqual([]);
  await backend.control({ version: "v2" });
  expect(await read(b, config, { start: 43, end: 63 })).toEqual({
    timestamps: [43, 53, 63],
    volume: [1, 1, 1],
    coverage: [{ start: 43, end: 63 }],
    misses: [],
  });
  // B's miss abutted A's coverage, so its fetch took point 33 as the flank.
  expect((await backend.state()).requests).toEqual({ "3-33": 1, "33-63": 1 });
  for (const page of [a, b]) {
    expect(await drainEvents(page, config, "cacheCleared")).toEqual([
      cleared(config.id),
    ]);
  }
  // A's v1 points are gone; only the flank point came back, from v2.
  expect(
    await read(a, config, { start: 3, end: 33 }, { cacheOnly: true }),
  ).toEqual({
    timestamps: [33],
    volume: [1],
    coverage: [{ start: 33, end: 33 }],
    misses: [{ range: { start: 3, end: 23 }, reason: "uncached" }],
  });
});

test("an answer from before the clear is dropped and fetched again", async ({
  context,
  backend,
}) => {
  const config = cacheConfig({ version: "v1" });
  const a = await open(context);
  const b = await open(context);
  await connect(a, backend.clientOptions());
  await connect(b, backend.clientOptions());
  await backend.control({ hold: { candles: 1 } });
  await start(a, "a", config, { start: 3, end: 33 });
  // Held: A's request was decided on arrival and will answer v1.
  await backend.waitHeld("candles", 1);
  await backend.control({ version: "v2" });
  const fresh = {
    timestamps: [43, 53, 63],
    volume: [1, 1, 1],
    coverage: [{ start: 43, end: 63 }],
    misses: [],
  };
  expect(await read(b, config, { start: 43, end: 63 })).toEqual(fresh);
  await backend.release("candles");
  expect(await settle(a, "a")).toEqual({
    timestamps: [3, 13, 23, 33],
    volume: [1, 1, 1, 1],
    coverage: [{ start: 3, end: 33 }],
    misses: [],
  });
  // A's held v1 answer, B's v2 fetch, then A's refetch, which abutted B's
  // coverage and took point 43 as the flank.
  expect((await backend.state()).requests).toEqual({
    "3-33": 1,
    "43-63": 1,
    "3-43": 1,
  });
  expect(
    await read(b, config, { start: 43, end: 63 }, { cacheOnly: true }),
  ).toEqual(fresh);
  for (const page of [a, b]) {
    expect(await drainEvents(page, config, "cacheCleared")).toEqual([
      cleared(config.id),
    ]);
  }
});
