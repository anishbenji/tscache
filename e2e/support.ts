import {
  type APIRequestContext,
  type BrowserContext,
  test as base,
  expect,
  type Page,
} from "@playwright/test";
import type {
  CacheConfig,
  ClientEvents,
  ClientOptions,
  GetOptions,
  HostingMode,
  Miss,
  Range,
  TscacheClient,
} from "../packages/tscache/src/entries/index";
import type {
  BackendControl,
  BackendSnapshot,
  Gate,
} from "../scripts/e2e-backend";

// Shared helpers for the Playwright suites. The page side is reached through
// window, whose shape is E2EWindow; every page.evaluate lives in this file.

export const workerUrl = "/dist/worker.js";

/** A get result as plain arrays, which compare with toEqual. */
interface Got {
  timestamps: number[];
  volume: number[];
  coverage: Range[];
  misses: Miss[];
}

interface E2EWindow {
  ready?: boolean;
  tscache: { createClient(options: ClientOptions): Promise<TscacheClient> };
  client: TscacheClient;
  /** Every client event this page heard, in order. */
  log: { event: keyof ClientEvents; payload: unknown }[];
  /** Gets started by `start`, by key. */
  gets: Map<string, { settled: boolean; promise: Promise<Got> }>;
}

/** The suites' cache: one point every 10 ms from 3, under a fresh id. */
export function cacheConfig(extra: Partial<CacheConfig> = {}): CacheConfig {
  return {
    id: crypto.randomUUID(),
    interval: 10,
    alignmentOffset: 3,
    fields: { price: "f64", volume: "i16" },
    ...extra,
  };
}

/** A new page of the context with the fixture page loaded. */
export async function open(
  context: BrowserContext,
  init?: () => void,
): Promise<Page> {
  const page = await context.newPage();
  if (init !== undefined) await page.addInitScript(init);
  await page.goto("/");
  await page.waitForFunction(() => (window as unknown as E2EWindow).ready);
  return page;
}

/** Creates the page's client and starts logging its events. */
export async function connect(
  page: Page,
  options: ClientOptions,
): Promise<{ mode: HostingMode; fallbacks: unknown[] }> {
  return page.evaluate(async (opts) => {
    const w = window as unknown as E2EWindow;
    w.client = await w.tscache.createClient(opts);
    w.log = [];
    w.gets = new Map();
    const events = [
      "authInvalid",
      "modeFallback",
      "cacheCleared",
      "mergeWarning",
    ] as const;
    for (const event of events) {
      w.client.on(event, (payload) => w.log.push({ event, payload }));
    }
    // modeFallback arrives on a zero timer queued inside createClient; this
    // later one runs after it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const fallbacks = w.log.filter((e) => e.event === "modeFallback");
    return { mode: w.client.mode, fallbacks: fallbacks.map((e) => e.payload) };
  }, options);
}

/** Puts points with price = volume = t. */
export async function put(
  page: Page,
  config: CacheConfig,
  timestamps: number[],
): Promise<void> {
  await page.evaluate(
    async ({ cfg, ts }) => {
      const w = window as unknown as E2EWindow;
      const cache = await w.client.cache(cfg);
      await cache.put({
        timestamps: new Float64Array(ts),
        fields: { price: new Float64Array(ts), volume: new Int16Array(ts) },
      });
    },
    { cfg: config, ts: timestamps },
  );
}

/**
 * Posts a get and returns without waiting for it; `settle` and `settled`
 * find it by `key`.
 */
export async function start(
  page: Page,
  key: string,
  config: CacheConfig,
  range: Range,
  options?: GetOptions,
): Promise<void> {
  await page.evaluate(
    async ({ key, cfg, range, options }) => {
      const w = window as unknown as E2EWindow;
      const cache = await w.client.cache(cfg);
      const promise = cache.get(range, options).then((got) => ({
        timestamps: Array.from(got.timestamps),
        volume: Array.from(got.fields.volume ?? []),
        coverage: got.coverage,
        misses: got.misses,
      }));
      const entry = { settled: false, promise };
      const done = () => {
        entry.settled = true;
      };
      promise.then(done, done);
      w.gets.set(key, entry);
    },
    { key, cfg: config, range, options },
  );
}

/** Whether the page has received the answer to the get under `key`. */
export function settled(page: Page, key: string): Promise<boolean> {
  return page.evaluate(
    (k) => (window as unknown as E2EWindow).gets.get(k)?.settled === true,
    key,
  );
}

/** Waits for the get under `key`. */
export function settle(page: Page, key: string): Promise<Got> {
  return page.evaluate((k) => {
    const entry = (window as unknown as E2EWindow).gets.get(k);
    if (entry === undefined) throw new Error(`no get started as ${k}`);
    return entry.promise;
  }, key);
}

/** A get, awaited. */
export async function read(
  page: Page,
  config: CacheConfig,
  range: Range,
  options?: GetOptions,
): Promise<Got> {
  const key = crypto.randomUUID();
  await start(page, key, config, range, options);
  return settle(page, key);
}

class Backend {
  /** Fresh per test: every test talks to the one server. */
  readonly ns: string = crypto.randomUUID();
  readonly #request: APIRequestContext;

  constructor(request: APIRequestContext) {
    this.#request = request;
  }

  /** Client options whose fetcher asks this backend with `token`. */
  clientOptions(token = "at-0"): ClientOptions {
    return {
      workerUrl,
      fetcher: { module: "/fetcher.js", context: { ns: this.ns, token } },
    };
  }

  async control(body: BackendControl): Promise<void> {
    const response = await this.#request.post(`/backend/${this.ns}/control`, {
      data: body,
    });
    expect(response.ok()).toBe(true);
  }

  async state(): Promise<BackendSnapshot> {
    const response = await this.#request.get(`/backend/${this.ns}/state`);
    return (await response.json()) as BackendSnapshot;
  }

  release(gate: Gate): Promise<void> {
    return this.control({ release: gate });
  }

  /** Resolves once `n` requests are held at the gate. */
  async waitHeld(gate: Gate, n: number): Promise<void> {
    await expect.poll(async () => (await this.state()).held[gate]).toBe(n);
  }
}

export const test = base.extend<{ backend: Backend }>({
  backend: async ({ request }, use) => {
    await use(new Backend(request));
  },
});

export { expect };
