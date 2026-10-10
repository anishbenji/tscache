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

/** What the fixture fetcher (pages/fetcher.js) expects as its context. */
interface FetcherContext {
  ns: string;
  token: string;
}

interface Tokens {
  access: string;
  /** null once spent by a refresh whose result could not be stored. */
  refresh: string | null;
}

/** The backend's first pair (scripts/e2e-backend.ts). */
const initialTokens: Tokens = { access: "at-0", refresh: "rt-0" };

/** pages/auth-refresh.js, the snippet the examples ship. */
interface RefreshSnippet {
  refreshOnAuthInvalid(
    client: TscacheClient,
    options: {
      access: string;
      load(): Tokens | Promise<Tokens>;
      save(tokens: Tokens): void | Promise<void>;
      refresh(token: string): Promise<Tokens>;
      toContext(access: string): FetcherContext;
      onSessionLost(error: unknown): void;
      lockName?: string;
    },
  ): () => void;
}

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
  /** updateAuth calls that resolved, counted from `installRefresh` on. */
  updates?: number;
  /** Errors the refresh snippet ended the session with. */
  sessionLost?: string[];
}

/** What pages/refresh-harness.js records in a scenario. */
export interface RefreshLog {
  /** Refresh tokens presented to the refresh endpoint, in order. */
  refreshed: string[];
  /** `tab:access` per updateAuth call, in order. */
  updates: string[];
  /** Tabs that ended the session. */
  lost: string[];
  /** The shared tokens at the end, where the scenario reports them. */
  stored?: Tokens;
}

/** pages/refresh-harness.js */
interface RefreshHarness {
  scenarios: Record<string, () => Promise<RefreshLog>>;
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
      "workerLost",
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

/** A rejection as it crosses page.evaluate. */
export interface Failure {
  name: string;
  message: string;
}

/** Waits for the get under `key` to reject; fails if it resolved. */
export function failure(page: Page, key: string): Promise<Failure> {
  return page.evaluate(async (k) => {
    const entry = (window as unknown as E2EWindow).gets.get(k);
    if (entry === undefined) throw new Error(`no get started as ${k}`);
    try {
      await entry.promise;
    } catch (error) {
      const { name, message } = error as Error;
      return { name, message };
    }
    throw new Error(`the get started as ${k} resolved`);
  }, key);
}

/** The rejection of a `cache()` call; fails if it resolved. */
export function cacheFailure(
  page: Page,
  config: CacheConfig,
): Promise<Failure> {
  return page.evaluate(async (cfg) => {
    try {
      await (window as unknown as E2EWindow).client.cache(cfg);
    } catch (error) {
      const { name, message } = error as Error;
      return { name, message };
    }
    throw new Error("cache() resolved");
  }, config);
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

/** Clears the cache, for every tab of a SharedWorker. */
export async function clear(page: Page, config: CacheConfig): Promise<void> {
  await page.evaluate(async (cfg) => {
    const cache = await (window as unknown as E2EWindow).client.cache(cfg);
    await cache.clear();
  }, config);
}

/**
 * Fails within 5 s unless the page's worker answers a cache-only get. A
 * failure detector, not a timing assumption: a dead worker would otherwise
 * leave the caller hanging until the test timeout.
 */
export async function expectWorkerAlive(
  page: Page,
  config: CacheConfig,
  range: Range,
): Promise<void> {
  await page.evaluate(
    async ({ cfg, range }) => {
      const w = window as unknown as E2EWindow;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              "the SharedWorker did not answer within 5 s; it dies with the renderer of the tab that created it (N32)",
            ),
          );
        }, 5000);
      });
      const answer = w.client
        .cache(cfg)
        .then((cache) => cache.get(range, { cacheOnly: true }));
      try {
        await Promise.race([answer, timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
    { cfg: config, range },
  );
}

/**
 * The page's events of one kind, once at least one has arrived. The page
 * then makes a round trip to the worker: port messages are ordered, so the
 * reply means every event sent before it was delivered too, and the caller
 * can assert an exact count.
 */
export async function drainEvents<E extends keyof ClientEvents>(
  page: Page,
  config: CacheConfig,
  event: E,
): Promise<ClientEvents[E][]> {
  await expect
    .poll(async () => (await heard(page, event)).length)
    .toBeGreaterThan(0);
  await page.evaluate(async (cfg) => {
    await (window as unknown as E2EWindow).client.cache(cfg);
  }, config);
  return heard(page, event);
}

/**
 * The page's events of one kind so far, without a round trip (for a client
 * whose worker may be gone; `drainEvents` gives exact counts otherwise).
 */
export function heard<E extends keyof ClientEvents>(
  page: Page,
  event: E,
): Promise<ClientEvents[E][]> {
  return page.evaluate(
    (e) =>
      (window as unknown as E2EWindow).log
        .filter((entry) => entry.event === e)
        .map((entry) => entry.payload as ClientEvents[E]),
    event,
  );
}

/**
 * Runs the refresh snippet in the page against the backend `ns`, with the
 * tokens in localStorage, which the pages of a context share; the first
 * install stores the backend's first pair. From here on the page counts the
 * client's updateAuth calls that resolved, whoever made them.
 */
export async function installRefresh(page: Page, ns: string): Promise<void> {
  await page.evaluate(
    async ({ ns, initial }) => {
      const w = window as unknown as E2EWindow;
      const client = w.client;
      const update = client.updateAuth.bind(client);
      w.updates = 0;
      client.updateAuth = async (context) => {
        await update(context);
        w.updates = (w.updates ?? 0) + 1;
      };
      const key = `tscache-e2e-auth:${ns}`;
      if (localStorage.getItem(key) === null) {
        localStorage.setItem(key, JSON.stringify(initial));
      }
      // A served URL, not a module of this repository's graph.
      const snippet = "/auth-refresh.js";
      const { refreshOnAuthInvalid } = (await import(
        snippet
      )) as RefreshSnippet;
      w.sessionLost = [];
      refreshOnAuthInvalid(client, {
        access: initial.access,
        load: () => JSON.parse(localStorage.getItem(key) ?? "null"),
        save: (tokens) => localStorage.setItem(key, JSON.stringify(tokens)),
        refresh: async (token) => {
          const response = await fetch(`/backend/${ns}/refresh`, {
            method: "POST",
            body: JSON.stringify({ refresh: token }),
          });
          if (!response.ok) {
            throw new Error(`refresh answered ${response.status}`);
          }
          return (await response.json()) as Tokens;
        },
        toContext: (access) => ({ ns, token: access }),
        onSessionLost: (error) => w.sessionLost?.push(String(error)),
      });
    },
    { ns, initial: initialTokens },
  );
}

/** Runs a scenario of pages/refresh-harness.js in the page. */
export function refreshScenario(page: Page, name: string): Promise<RefreshLog> {
  return page.evaluate(async (scenario) => {
    // A served URL, not a module of this repository's graph.
    const url = "/refresh-harness.js";
    const { scenarios } = (await import(url)) as RefreshHarness;
    const run = scenarios[scenario];
    if (run === undefined) throw new Error(`no scenario ${scenario}`);
    return run();
  }, name);
}

/** Errors the page's refresh snippet ended the session with. */
export function sessionLost(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as E2EWindow).sessionLost ?? [],
  );
}

/** The page's updateAuth calls that resolved since `installRefresh`. */
export function updateCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as E2EWindow).updates ?? 0);
}

export async function updateAuth(
  page: Page,
  context: FetcherContext,
): Promise<void> {
  await page.evaluate(async (ctx) => {
    await (window as unknown as E2EWindow).client.updateAuth(ctx);
  }, context);
}

/** How many holders and waiters the Web Lock `name` has in the page's origin. */
export function lockQueue(
  page: Page,
  name: string,
): Promise<{ held: number; pending: number }> {
  return page.evaluate(async (n) => {
    const { held = [], pending = [] } = await navigator.locks.query();
    return {
      held: held.filter((lock) => lock.name === n).length,
      pending: pending.filter((lock) => lock.name === n).length,
    };
  }, name);
}

class Backend {
  /** Fresh per test: every test talks to the one server. */
  readonly ns: string = crypto.randomUUID();
  readonly #request: APIRequestContext;

  constructor(request: APIRequestContext) {
    this.#request = request;
  }

  /** Client options whose fetcher asks this backend with `token`. */
  clientOptions(token = initialTokens.access): ClientOptions {
    const context: FetcherContext = { ns: this.ns, token };
    return { workerUrl, fetcher: { module: "/fetcher.js", context } };
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

  /** Rotates the tokens the way a client would. */
  async refresh(token: string): Promise<Tokens> {
    const response = await this.#request.post(`/backend/${this.ns}/refresh`, {
      data: { refresh: token },
    });
    expect(response.ok()).toBe(true);
    return (await response.json()) as Tokens;
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
