import {
  cacheConfig,
  connect,
  expect,
  open,
  put,
  read,
  test,
  workerUrl,
} from "./support";

// Real browser coverage for the hostings (architecture §4.8, N26): a
// dedicated Worker, a SharedWorker shared by two pages, the in-process pin
// and the no-SharedWorker fallback (Chrome on Android has none).

const config = cacheConfig();

test("a dedicated Worker hosts the engine", async ({ context }) => {
  const page = await open(context);
  const { mode, fallbacks } = await connect(page, {
    workerUrl,
    mode: "dedicated",
  });
  expect(mode).toBe("dedicated");
  expect(fallbacks).toEqual([]);
  await put(page, config, [3, 13]);
  expect(await read(page, config, { start: 3, end: 23 })).toEqual({
    timestamps: [3, 13],
    volume: [3, 13],
    coverage: [{ start: 3, end: 13 }],
    misses: [{ range: { start: 23, end: 23 }, reason: "uncached" }],
  });
});

test("two pages of one context share a SharedWorker and its data", async ({
  context,
}) => {
  const a = await open(context);
  const b = await open(context);
  expect((await connect(a, { workerUrl })).mode).toBe("shared");
  expect((await connect(b, { workerUrl })).mode).toBe("shared");
  await put(a, config, [3, 13]);
  expect(await read(b, config, { start: 3, end: 13 })).toEqual({
    timestamps: [3, 13],
    volume: [3, 13],
    coverage: [{ start: 3, end: 13 }],
    misses: [],
  });
});

test("the in-process pin needs no worker", async ({ context }) => {
  const page = await open(context);
  expect((await connect(page, { mode: "in-process" })).mode).toBe("in-process");
  await put(page, config, [3]);
  expect((await read(page, config, { start: 3, end: 3 })).timestamps).toEqual([
    3,
  ]);
});

test("without SharedWorker the chain steps down to a dedicated Worker", async ({
  context,
}) => {
  const page = await open(context, () => {
    delete (window as { SharedWorker?: unknown }).SharedWorker;
  });
  const { mode, fallbacks } = await connect(page, { workerUrl });
  expect(mode).toBe("dedicated");
  expect(fallbacks).toEqual([
    {
      from: "shared",
      to: "dedicated",
      reason: expect.stringMatching(/SharedWorker/),
    },
  ]);
});

// The in-process hosting is a chunk of its own that index.js loads with
// import() (architecture §4.8): a worker-hosted page never requests it.
const inProcessChunk = /\/dist\/in-process-[\w-]+\.js$/;

test("a SharedWorker page never requests the in-process chunk", async ({
  context,
}) => {
  const requested: string[] = [];
  context.on("request", (request) => requested.push(request.url()));
  const page = await open(context);
  expect((await connect(page, { workerUrl })).mode).toBe("shared");
  await put(page, config, [3]);
  expect((await read(page, config, { start: 3, end: 3 })).timestamps).toEqual([
    3,
  ]);
  expect(requested.some((url) => url.endsWith("/dist/index.js"))).toBe(true);
  expect(requested.filter((url) => inProcessChunk.test(url))).toEqual([]);
});

test("the in-process pin requests the in-process chunk", async ({
  context,
}) => {
  const requested: string[] = [];
  context.on("request", (request) => requested.push(request.url()));
  const page = await open(context);
  expect((await connect(page, { mode: "in-process" })).mode).toBe("in-process");
  expect(requested.filter((url) => inProcessChunk.test(url))).toHaveLength(1);
});

test("an in-process chunk that fails to load rejects createClient", async ({
  context,
}) => {
  await context.route(inProcessChunk, (route) => route.abort());
  const page = await open(context);
  await expect(connect(page, { mode: "in-process" })).rejects.toThrow(
    /the in-process hosting could not be loaded/,
  );
});
