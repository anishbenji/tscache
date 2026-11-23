import { type CacheHandle, createClient } from "@anishbenji/tscache";
import { dehydrate, type Hydration } from "@examples/mock-backend/hydration";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  type Attempt,
  attempts,
  type Outcomes,
  seedCache,
} from "../src/connecting";

/** A promise and the functions that settle it. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** One started attempt: what it was given, and how to settle it. */
interface Started {
  attempt: Attempt;
  resolve(result: string): void;
  reject(error: unknown): void;
}

/** Attempts whose `connect` a test settles by hand, and what they report. */
function harness() {
  const started: Started[] = [];
  const seen: string[] = [];
  const on: Outcomes<string> = {
    connected: (result) => seen.push(`connected ${result}`),
    lost: (reason) => seen.push(`lost ${reason}`),
    failed: (error) => seen.push(`failed ${(error as Error).message}`),
    drop: (result) => seen.push(`dropped ${result}`),
  };
  const stop = attempts((attempt) => {
    const { promise, resolve, reject } = deferred<string>();
    started.push({ attempt, resolve, reject });
    return promise;
  }, on);
  return { started, seen, stop };
}

/** Lets every settled promise's handlers run. */
const settle = () => new Promise<void>((done) => setImmediate(done));

describe("attempts", () => {
  it("reports a live attempt's result as connected", async () => {
    const { started, seen } = harness();
    expect(started).toHaveLength(1);
    expect(started[0]?.attempt.live()).toBe(true);
    started[0]?.resolve("first");
    await settle();
    expect(seen).toEqual(["connected first"]);
  });

  it("drops a lost attempt's late result, and the next attempt connects", async () => {
    const { started, seen } = harness();
    const first = started[0];
    first?.attempt.lose("crashed");
    expect(first?.attempt.live()).toBe(false);
    expect(started).toHaveLength(2);
    expect(started[1]?.attempt.live()).toBe(true);

    // The lost attempt's seeding failed but no longer fails the attempt, so
    // it resolves after the next one connected: it must not replace it.
    started[1]?.resolve("second");
    await settle();
    first?.resolve("first");
    await settle();
    expect(seen).toEqual(["lost crashed", "connected second", "dropped first"]);
  });

  it("drops the result of an attempt that resolves after stop, and starts no other", async () => {
    const { started, seen, stop } = harness();
    stop();
    expect(started[0]?.attempt.live()).toBe(false);
    started[0]?.attempt.lose("closed");
    started[0]?.resolve("first");
    await settle();
    expect(started).toHaveLength(1);
    expect(seen).toEqual(["dropped first"]);
  });

  it("reports an attempt that fails to connect", async () => {
    const { started, seen } = harness();
    started[0]?.reject(new Error("no worker"));
    await settle();
    expect(seen).toEqual(["failed no worker"]);
  });
});

describe("seedCache", () => {
  /** A server's snapshot of [0, 20] for a cache like the page's. */
  let hydration: Hydration;
  beforeAll(async () => {
    const server = await createClient({ mode: "in-process" });
    const cache = await server.cache({
      id: "candles",
      interval: 10,
      fields: { v: "f64" },
    });
    const range = { start: 0, end: 20 };
    await cache.put({ timestamps: [0, 20], fields: { v: [1, 2] } }, { range });
    const { snapshot } = await cache.get(range, {
      cacheOnly: true,
      snapshot: true,
    });
    await server.dispose();
    if (snapshot === undefined) throw new Error("no snapshot");
    hydration = dehydrate(range, snapshot);
  });

  /** A cache whose `hydrate` rejects with `error`. */
  const refusing = (error: Error) =>
    ({
      id: "candles",
      hydrate: () => Promise.reject(error),
    }) as unknown as CacheHandle;

  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("DEV", true);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("counts a failure as not seeded, and warns in development with the message", async () => {
    const cache = refusing(new Error("invalid snapshot: overlaps"));
    expect(await seedCache(cache, hydration, () => true)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const args = warn.mock.calls[0] ?? [];
    expect(args).toHaveLength(1);
    expect(args[0]).toContain("invalid snapshot: overlaps");
    expect(args[0]).toContain('"candles"');
  });

  it("is silent when the attempt no longer counts, as when its worker was lost", async () => {
    const cache = refusing(new Error("worker lost"));
    expect(await seedCache(cache, hydration, () => false)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("is silent in production", async () => {
    vi.stubEnv("DEV", false);
    const cache = refusing(new Error("invalid snapshot: overlaps"));
    expect(await seedCache(cache, hydration, () => true)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});
