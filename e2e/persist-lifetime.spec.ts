import {
  cacheConfig,
  connect,
  expect,
  knowsExtendedLifetime,
  open,
  put,
  read,
  stored,
  test,
} from "./support";

// The SharedWorker's extended lifetime (architecture §4.10.8, N50; step 57):
// openShared creates the worker with `extendedLifetime: true`, so a browser
// that knows the option keeps it running after its last tab closes, and the
// final flush can land. It runs only where the browser reads the member.

test("after the last tab closes inside the debounce window, the worker lives on and its flush lands", async ({
  context,
  backend,
}) => {
  const persisted = cacheConfig({ persist: true });
  const memory = cacheConfig();
  const a = await open(context);
  test.skip(
    !(await knowsExtendedLifetime(a)),
    "this browser does not read SharedWorker's extendedLifetime",
  );
  expect((await connect(a, backend.clientOptions())).mode).toBe("shared");
  // Written behind, about a second after the put; the tab closes at once.
  await put(a, persisted, [3, 13]);
  await put(a, memory, [3, 13]);
  await a.close();
  const b = await open(context);
  await expect
    .poll(() => stored(b, persisted.id))
    .toEqual({ caches: 1, pages: 1 });
  // The same worker still runs: its memory holds the cache that persists
  // nothing.
  expect((await connect(b, backend.clientOptions())).mode).toBe("shared");
  expect(
    await read(b, memory, { start: 3, end: 13 }, { cacheOnly: true }),
  ).toEqual({
    timestamps: [3, 13],
    volume: [3, 13],
    coverage: [{ start: 3, end: 13 }],
    misses: [],
  });
});
