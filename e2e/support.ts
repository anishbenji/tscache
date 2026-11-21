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
  MemoryStats,
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

/**
 * The fixture fetcher under a second URL (scripts/e2e-server.ts): another
 * generation key, so a SharedWorker of its own (architecture §2.7, N126).
 */
export const secondFetcher = "/fetcher-b.js";

/**
 * The built package as a later library version (scripts/e2e-server.ts): a
 * page opened with `openNext` loads its client from there, and this is its
 * worker.
 */
export const nextWorkerUrl = "/dist-next/worker.js";
/** The `LIB_VERSION` the later library reports. */
export const nextLibrary = "99.0.0";

/** What the fixture fetcher (pages/fetcher.js) expects as its context. */
interface FetcherContext {
  ns: string;
  token: string;
  /** How it asks for candles; default a columns body. */
  format?: "columns" | "json";
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
      load(): Tokens | Promise<Tokens>;
      save(tokens: Tokens): void | Promise<void>;
      refresh(token: string): Promise<Tokens>;
      toContext(access: string): FetcherContext;
      accessOf(context: FetcherContext): string;
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
  /** Views that follow a cache with cacheChanged, by key (`follow`). */
  followers?: Map<string, Follower>;
}

/** A view following a cache by the read rule (architecture §2.7, N84). */
interface Follower {
  events: ClientEvents["cacheChanged"][];
  fetching: number;
  cacheOnly: number;
  /** Every read it started, settled or not. */
  reads: Promise<unknown>[];
  last?: Got;
}

/** What `followed` reports of a follower once its reads settled. */
export interface Followed {
  events: ClientEvents["cacheChanged"][];
  /** Reads it made with a fetching get, and with cacheOnly. */
  fetching: number;
  cacheOnly: number;
  /** Its last read's result. */
  last?: Got;
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

/**
 * A new page of the context whose client is the later library version's
 * (`nextLibrary`); connect it with `nextWorkerUrl`.
 */
export async function openNext(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto("/next/");
  await page.waitForFunction(() => (window as unknown as E2EWindow).ready);
  return page;
}

/**
 * Creates the page's client and starts logging its events. `superseded` is
 * `client.superseded` as it was when `createClient` resolved.
 */
export async function connect(
  page: Page,
  options: ClientOptions,
): Promise<{
  mode: HostingMode;
  fallbacks: unknown[];
  superseded: ClientEvents["superseded"] | undefined;
}> {
  return page.evaluate(async (opts) => {
    const w = window as unknown as E2EWindow;
    w.client = await w.tscache.createClient(opts);
    const superseded = w.client.superseded;
    w.log = [];
    w.gets = new Map();
    const events = [
      "authInvalid",
      "modeFallback",
      "cacheCleared",
      "mergeWarning",
      "workerLost",
      "persistStopped",
      "superseded",
    ] as const;
    for (const event of events) {
      w.client.on(event, (payload) => w.log.push({ event, payload }));
    }
    // modeFallback arrives on a zero timer queued inside createClient; this
    // later one runs after it.
    // clock-ok: zero timers run in the order queued; this waits for no time.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const fallbacks = w.log.filter((e) => e.event === "modeFallback");
    return {
      mode: w.client.mode,
      fallbacks: fallbacks.map((e) => e.payload),
      superseded,
    };
  }, options);
}

/** `client.superseded` of the page's client, now. */
export function supersededOf(
  page: Page,
): Promise<ClientEvents["superseded"] | undefined> {
  return page.evaluate(
    () => (window as unknown as E2EWindow).client.superseded,
  );
}

/** The features the page's client reports of its worker, sorted. */
export function featuresOf(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...(window as unknown as E2EWindow).client.features].sort(),
  );
}

/**
 * A round trip to the page's worker: port messages are ordered, so after
 * it every event the worker sent before has been delivered.
 */
export async function roundTrip(
  page: Page,
  config: CacheConfig,
): Promise<void> {
  await page.evaluate(async (cfg) => {
    await (window as unknown as E2EWindow).client.cache(cfg);
  }, config);
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

/**
 * Makes the page a view of `range` that follows the cache as the
 * integrations do (§2.7, N84): it subscribes, then reads (`initial` says
 * how), and on each overlapping cacheChanged reads again, with cacheOnly
 * when the event wrote something and with a fetching get when it wrote
 * nothing and cleared or removed. One read per event; no frame coalescing,
 * so every reaction is counted.
 */
export async function follow(
  page: Page,
  key: string,
  config: CacheConfig,
  range: Range,
  initial: "cacheOnly" | "fetching",
): Promise<void> {
  await page.evaluate(
    async ({ key, cfg, range, initial }) => {
      const w = window as unknown as E2EWindow;
      const cache = await w.client.cache(cfg);
      const follower: Follower = {
        events: [],
        fetching: 0,
        cacheOnly: 0,
        reads: [],
      };
      w.followers ??= new Map();
      w.followers.set(key, follower);
      const read = (fetching: boolean) => {
        if (fetching) follower.fetching++;
        else follower.cacheOnly++;
        const promise = cache
          .get(range, fetching ? {} : { cacheOnly: true })
          .then((got) => {
            follower.last = {
              timestamps: Array.from(got.timestamps),
              volume: Array.from(got.fields.volume ?? []),
              coverage: got.coverage,
              misses: got.misses,
            };
          });
        follower.reads.push(promise);
        return promise;
      };
      const overlaps = (r: Range) =>
        r.start <= range.end && range.start <= r.end;
      // Subscribe, then read: both go out on one port, in this order.
      cache.on("cacheChanged", (event) => {
        follower.events.push(event);
        if (event.written.length > 0) {
          const shown =
            event.cleared ||
            [...event.written, ...event.removed].some(overlaps);
          if (shown) void read(false);
        } else if (event.cleared || event.removed.some(overlaps)) {
          void read(true);
        }
      });
      await read(initial === "fetching");
    },
    { key, cfg: config, range, initial },
  );
}

/**
 * A follower's events and reads, after a round trip to the worker (every
 * event sent before it has arrived) and once every read it started, also
 * in reaction to those events, has settled.
 */
export function followed(
  page: Page,
  key: string,
  config: CacheConfig,
): Promise<Followed> {
  return page.evaluate(
    async ({ key, cfg }) => {
      const w = window as unknown as E2EWindow;
      const follower = w.followers?.get(key);
      if (follower === undefined) throw new Error(`no follower ${key}`);
      await w.client.cache(cfg);
      let started: number;
      do {
        started = follower.reads.length;
        await Promise.all(follower.reads);
      } while (started !== follower.reads.length);
      const { events, fetching, cacheOnly, last } = follower;
      return { events, fetching, cacheOnly, ...(last ? { last } : {}) };
    },
    { key, cfg: config },
  );
}

/** What the page's client reports of its worker's memory (§2.9). */
export function memoryStats(page: Page): Promise<MemoryStats> {
  return page.evaluate(() =>
    (window as unknown as E2EWindow).client.memoryStats(),
  );
}

/** Empties every cache and the disk (N54, N66). */
export async function clearAll(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await (window as unknown as E2EWindow).client.clearAll();
  });
}

/** Records in the origin's persistence database (architecture §4.10.2). */
export interface Stored {
  caches: number;
  pages: number;
}

/**
 * Counts the records the origin's `tscache` database holds, for one cache
 * or, without `cacheId`, for all; undefined when there is no database. It
 * never creates one: an empty database at version 1 would have no object
 * stores, and the worker's own opening would then not create them.
 */
export function stored(
  page: Page,
  cacheId?: string,
): Promise<Stored | undefined> {
  return page.evaluate(async (id) => {
    const listed = await indexedDB.databases();
    if (!listed.some((info) => info.name === "tscache")) return undefined;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("tscache");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const count = (request: IDBRequest<number>) =>
      new Promise<number>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    try {
      const tx = db.transaction(["caches", "pages"]);
      const caches = tx.objectStore("caches");
      const pages = tx.objectStore("pages");
      if (id === undefined) {
        return {
          caches: await count(caches.count()),
          pages: await count(pages.count()),
        };
      }
      const range = IDBKeyRange.bound([id, -Infinity], [id, Infinity]);
      return {
        caches: await count(caches.count(id)),
        pages: await count(pages.count(range)),
      };
    } finally {
      db.close();
    }
  }, cacheId);
}

/**
 * The page numbers of the cache's page records in the origin's database,
 * ascending; undefined when there is no database (as `stored`).
 */
export function storedPages(
  page: Page,
  cacheId: string,
): Promise<number[] | undefined> {
  return page.evaluate(async (id) => {
    const listed = await indexedDB.databases();
    if (!listed.some((info) => info.name === "tscache")) return undefined;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("tscache");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const range = IDBKeyRange.bound([id, -Infinity], [id, Infinity]);
      const request = db
        .transaction("pages")
        .objectStore("pages")
        .getAllKeys(range);
      const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return keys.map((key) => (key as [string, number])[1]);
    } finally {
      db.close();
    }
  }, cacheId);
}

/**
 * Whether the browser reads the `extendedLifetime` member of SharedWorker
 * options: a getter on the options object is called only by a browser that
 * knows the member. The probe worker is a new one, under its own URL.
 */
export function knowsExtendedLifetime(page: Page): Promise<boolean> {
  return page.evaluate((url) => {
    let read = false;
    const options = {
      type: "module" as const,
      get extendedLifetime() {
        read = true;
        return false;
      },
    };
    new SharedWorker(`${url}?probe=extended-lifetime`, options);
    return read;
  }, workerUrl);
}

/** Clears the cache, for every tab of a SharedWorker. */
export async function clear(page: Page, config: CacheConfig): Promise<void> {
  await page.evaluate(async (cfg) => {
    const cache = await (window as unknown as E2EWindow).client.cache(cfg);
    await cache.clear();
  }, config);
}

/**
 * Waits until the page's worker answers a cache-only get, in a named step:
 * a dead worker leaves the step hanging, and the test's own timeout ends
 * it, reporting the step. No guard of its own, which would race the
 * worker against a deadline (docs/testing.md).
 */
export async function expectWorkerAlive(
  page: Page,
  config: CacheConfig,
  range: Range,
): Promise<void> {
  await base.step(
    "the SharedWorker answers a cache-only get (it dies with the renderer of the tab that created it, N32)",
    async () => {
      await page.evaluate(
        async ({ cfg, range }) => {
          const w = window as unknown as E2EWindow;
          const cache = await w.client.cache(cfg);
          await cache.get(range, { cacheOnly: true });
        },
        { cfg: config, range },
      );
    },
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
        accessOf: (context) => context.token,
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

  /**
   * Client options whose fetcher asks this backend with `token`. `module`
   * is the fetcher's URL: another one is another generation key (N126).
   */
  clientOptions(
    token = initialTokens.access,
    module = "/fetcher.js",
  ): ClientOptions {
    const context: FetcherContext = { ns: this.ns, token };
    return { workerUrl, fetcher: { module, context } };
  }

  /**
   * The URL of this backend's swappable fetcher module, whose contents
   * `control({ fetcher })` changes behind it (scripts/e2e-backend.ts).
   */
  get swappableFetcher(): string {
    return `/backend/${this.ns}/fetcher.js`;
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
