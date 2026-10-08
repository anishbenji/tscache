import { expect, type Page, test } from "@playwright/test";

// Real browser coverage for the hostings (architecture §4.8, N26): a
// dedicated Worker, a SharedWorker shared by two pages, the in-process pin
// and the no-SharedWorker fallback (Chrome on Android has none).

const workerUrl = "/dist/worker.js";
const config = {
  id: "e2e",
  interval: 10,
  alignmentOffset: 3,
  fields: { price: "f64", volume: "i16" },
};

async function open(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => (window as { ready?: boolean }).ready);
}

/** Creates a client in the page under window.client; returns its mode and fallbacks. */
async function connect(
  page: Page,
  options: Record<string, unknown>,
): Promise<{ mode: string; fallbacks: unknown[] }> {
  return page.evaluate(async (opts) => {
    const w = window as unknown as {
      tscache: { createClient(o: unknown): Promise<unknown> };
      client: { mode: string; on(e: string, fn: (p: unknown) => void): void };
    };
    const client = (await w.tscache.createClient(opts)) as typeof w.client;
    w.client = client;
    const fallbacks: unknown[] = [];
    client.on("modeFallback", (p) => fallbacks.push(p));
    await new Promise((r) => setTimeout(r, 20));
    return { mode: client.mode, fallbacks };
  }, options);
}

async function put(page: Page, timestamps: number[]): Promise<void> {
  await page.evaluate(
    async ({ cfg, ts }) => {
      const w = window as unknown as {
        client: {
          cache(c: unknown): Promise<{ put(b: unknown): Promise<unknown> }>;
        };
      };
      const cache = await w.client.cache(cfg);
      await cache.put({
        timestamps: new Float64Array(ts),
        fields: { price: new Float64Array(ts), volume: new Int16Array(ts) },
      });
    },
    { cfg: config, ts: timestamps },
  );
}

async function read(page: Page, range: { start: number; end: number }) {
  return page.evaluate(
    async ({ cfg, r }) => {
      const w = window as unknown as {
        client: {
          cache(c: unknown): Promise<{
            get(r: unknown): Promise<{
              timestamps: Float64Array;
              coverage: unknown[];
              misses: unknown[];
            }>;
          }>;
        };
      };
      const cache = await w.client.cache(cfg);
      const got = await cache.get(r);
      return {
        timestamps: Array.from(got.timestamps),
        coverage: got.coverage,
        misses: got.misses,
      };
    },
    { cfg: config, r: range },
  );
}

test("a dedicated Worker hosts the engine", async ({ page }) => {
  await open(page);
  const { mode, fallbacks } = await connect(page, {
    workerUrl,
    mode: "dedicated",
  });
  expect(mode).toBe("dedicated");
  expect(fallbacks).toEqual([]);
  await put(page, [3, 13]);
  expect(await read(page, { start: 3, end: 23 })).toEqual({
    timestamps: [3, 13],
    coverage: [{ start: 3, end: 13 }],
    misses: [{ range: { start: 23, end: 23 }, reason: "uncached" }],
  });
});

test("two pages of one context share a SharedWorker and its data", async ({
  context,
}) => {
  const a = await context.newPage();
  const b = await context.newPage();
  await open(a);
  await open(b);
  expect((await connect(a, { workerUrl })).mode).toBe("shared");
  expect((await connect(b, { workerUrl })).mode).toBe("shared");
  await put(a, [3, 13]);
  expect(await read(b, { start: 3, end: 13 })).toEqual({
    timestamps: [3, 13],
    coverage: [{ start: 3, end: 13 }],
    misses: [],
  });
});

test("the in-process pin needs no worker", async ({ page }) => {
  await open(page);
  expect((await connect(page, { mode: "in-process" })).mode).toBe("in-process");
  await put(page, [3]);
  expect((await read(page, { start: 3, end: 3 })).timestamps).toEqual([3]);
});

test("without SharedWorker the chain steps down to a dedicated Worker", async ({
  page,
}) => {
  await page.addInitScript(() => {
    delete (window as { SharedWorker?: unknown }).SharedWorker;
  });
  await open(page);
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

test("two pages share one SharedWorker fetch for the same range", async ({
  context,
}) => {
  const a = await context.newPage();
  const b = await context.newPage();
  await open(a);
  await open(b);
  // The fixture holds its answer for 400 ms, so both gets are in flight at
  // once; only in-flight deduplication can make them share one fetch.
  const options = {
    workerUrl,
    fetcher: { module: "/fetcher.js", context: { delayMs: 400 } },
  };
  expect((await connect(a, options)).mode).toBe("shared");
  expect((await connect(b, options)).mode).toBe("shared");
  const started = Date.now();
  const [ra, rb] = await Promise.all([
    read(a, { start: 3, end: 33 }),
    read(b, { start: 3, end: 33 }),
  ]);
  expect(Date.now() - started).toBeGreaterThanOrEqual(350);
  expect(ra).toEqual({
    timestamps: [3, 13, 23, 33],
    coverage: [{ start: 3, end: 33 }],
    misses: [],
  });
  expect(rb).toEqual(ra);
  // The fetcher ran once for both tabs: volume carries its call count.
  const volumes = await a.evaluate(async (cfg) => {
    const w = window as unknown as {
      client: {
        cache(c: unknown): Promise<{
          get(r: unknown): Promise<{ fields: { volume: Int16Array } }>;
        }>;
      };
    };
    const cache = await w.client.cache(cfg);
    return Array.from((await cache.get({ start: 3, end: 33 })).fields.volume);
  }, config);
  expect(volumes).toEqual([1, 1, 1, 1]);
});
