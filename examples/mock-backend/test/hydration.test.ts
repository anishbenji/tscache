import {
  type CacheConfig,
  type CacheHandle,
  createClient,
  type Range,
  type TscacheClient,
  TscacheError,
} from "@anishbenji/tscache";
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
  dehydrate,
  type Hydration,
  hydrationScript,
  readHydration,
  seed,
  seedCache,
} from "../src/hydration";

const MINUTE = 60_000;
/** Text a warning must never quote: it stands for the page's data. */
const MARKER = "SECRETMARKER";
const T0 = Date.UTC(2026, 5, 1);
const at = (slot: number) => T0 + slot * MINUTE;

const config: CacheConfig = {
  id: "sensor/test",
  interval: MINUTE,
  fields: { value: "f64", level: "f32", battery: "u8" },
};

const clients: TscacheClient[] = [];

async function cacheOf() {
  const client = await createClient({ mode: "in-process" });
  clients.push(client);
  return client.cache(config);
}

/** The text a browser reads back from the script element. */
function roundTrip(hydration: Hydration): Hydration {
  const html = hydrationScript(hydration);
  const text = html.slice(html.indexOf(">") + 1, html.lastIndexOf("</script>"));
  vi.stubGlobal("document", {
    getElementById: (id: string) =>
      id === "tscache-hydration" ? { textContent: text } : null,
  });
  return readHydration();
}

/** The server's read of `range` with its snapshot, as the page carries it. */
async function served(server: CacheHandle, range: Range): Promise<Hydration> {
  const { snapshot } = await server.get(range, { snapshot: true });
  if (snapshot === undefined) throw new Error("no snapshot");
  return dehydrate(range, snapshot);
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(clients.splice(0).map((client) => client.dispose()));
});

describe("SSR hydration", () => {
  it("carries covered points and gaps exactly, and leaves the provisional tail out", async () => {
    const server = await cacheOf();
    // Slots 0–9 are final, with nothing at 3, 4 and 7; slots 10–11 are
    // provisional.
    const slots = [0, 1, 2, 5, 6, 8, 9, 10, 11];
    await server.put(
      {
        timestamps: slots.map(at),
        fields: {
          value: [
            Number.NaN,
            -0,
            Number.POSITIVE_INFINITY,
            1.1,
            2.2,
            3.3,
            4.4,
            5,
            6,
          ],
          level: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9],
          battery: [255, 0, 1, 2, 3, 4, 5, 6, 7],
        },
        meta: { finalizedUntil: at(10) },
      },
      { range: { start: at(0), end: at(11) } },
    );
    const range = { start: at(0), end: at(11) };
    const answer = await server.get(range);
    expect(answer.coverage).toEqual([{ start: at(0), end: at(9) }]);

    const browser = await cacheOf();
    expect(await seed(browser, roundTrip(await served(server, range)))).toEqual(
      { applied: [{ start: at(0), end: at(9) }] },
    );
    const planted = await browser.get(range);

    expect(planted.coverage).toEqual([{ start: at(0), end: at(9) }]);
    expect(planted.misses).toEqual([
      { range: { start: at(10), end: at(11) }, reason: "uncached" },
    ]);
    expect([...planted.timestamps]).toEqual(slots.slice(0, 7).map(at));
    expect(Object.is(planted.fields.value?.[0], Number.NaN)).toBe(true);
    expect(Object.is(planted.fields.value?.[1], -0)).toBe(true);
    expect(planted.fields.value?.[2]).toBe(Number.POSITIVE_INFINITY);
    expect(planted.fields.level).toEqual(answer.fields.level?.slice(0, 7));
    expect(planted.fields.battery).toEqual(
      new Uint8Array([255, 0, 1, 2, 3, 4, 5]),
    );
  });

  it("applies each covered range with its own points", async () => {
    const server = await cacheOf();
    await server.put(
      {
        timestamps: [at(0), at(2)],
        fields: { value: [1, 2], level: [1, 2], battery: [1, 2] },
      },
      { range: { start: at(0), end: at(2) } },
    );
    await server.put(
      { timestamps: [at(6)], fields: { value: [3], level: [3], battery: [3] } },
      { range: { start: at(5), end: at(7) } },
    );
    const range = { start: at(0), end: at(9) };
    const hydration = await served(server, range);
    expect(hydration.snapshot.coverage).toEqual([
      { start: at(0), end: at(2) },
      { start: at(5), end: at(7) },
    ]);

    const browser = await cacheOf();
    await seed(browser, roundTrip(hydration));
    const planted = await browser.get(range);
    expect(planted.coverage).toEqual(hydration.snapshot.coverage);
    expect([...planted.timestamps]).toEqual([at(0), at(2), at(6)]);
    expect([...(planted.fields.value ?? [])]).toEqual([1, 2, 3]);
  });

  it("never replaces what the browser's cache already covers", async () => {
    const server = await cacheOf();
    const slots = [0, 1, 2, 3, 4, 5];
    await server.put(
      {
        timestamps: slots.map(at),
        fields: { value: slots.map(() => 1), level: slots, battery: slots },
      },
      { range: { start: at(0), end: at(5) } },
    );
    const range = { start: at(0), end: at(5) };
    const hydration = await served(server, range);

    // Another tab's fetch already covered slots 2–3, with later values.
    const browser = await cacheOf();
    await browser.put(
      {
        timestamps: [at(2), at(3)],
        fields: { value: [9, 9], level: [9, 9], battery: [9, 9] },
      },
      { range: { start: at(2), end: at(3) } },
    );
    expect(await seed(browser, roundTrip(hydration))).toEqual({
      applied: [
        { start: at(0), end: at(1) },
        { start: at(4), end: at(5) },
      ],
    });
    const planted = await browser.get(range);
    expect(planted.coverage).toEqual([range]);
    expect([...(planted.fields.value ?? [])]).toEqual([1, 1, 9, 9, 1, 1]);
  });

  it("escapes < so no value can close the script element", () => {
    const hydration: Hydration = {
      range: { start: 0, end: 0 },
      snapshot: {
        format: 1,
        interval: 1,
        alignmentOffset: 0,
        fields: { "</script><b>": "f64" },
        range: { start: 0, end: 0 },
        coverage: [],
        segments: [],
      },
    };
    const html = hydrationScript(hydration);
    expect(html.indexOf("</script>")).toBe(html.length - "</script>".length);
    expect(roundTrip(hydration)).toEqual(hydration);
  });

  it("counts an older worker's unknown op as nothing applied, and lets other failures through", async () => {
    const server = await cacheOf();
    const hydration = await served(server, { start: at(0), end: at(1) });
    const refusing = (message: string) =>
      ({
        hydrate: () => Promise.reject(new TscacheError(message)),
      }) as unknown as CacheHandle;
    await expect(
      seed(refusing("unknown op hydrate"), hydration),
    ).resolves.toEqual({ applied: [] });
    await expect(
      seed(refusing("invalid snapshot: interval differs"), hydration),
    ).rejects.toThrow(/invalid snapshot/);
    // A validation error that merely mentions the phrase is still an error.
    await expect(
      seed(
        refusing(
          'invalid segment payload: field "v" has dtype unknown op, the schema says f64',
        ),
        hydration,
      ),
    ).rejects.toThrow(/invalid segment payload/);
  });

  it("refuses a snapshot of another dataset version", async () => {
    const server = await cacheOf();
    await server.put(
      {
        timestamps: [at(0)],
        fields: { value: [1], level: [1], battery: [1] },
        meta: { version: "old" },
      },
      { range: { start: at(0), end: at(1) } },
    );
    const hydration = await served(server, { start: at(0), end: at(1) });
    const browser = await cacheOf();
    await browser.put({
      timestamps: [at(5)],
      fields: { value: [5], level: [5], battery: [5] },
      meta: { version: "new" },
    });
    expect(await seed(browser, roundTrip(hydration))).toEqual({
      applied: [],
      skipped: "version-mismatch",
    });
  });

  it("says so when the page carries no hydration", () => {
    vi.stubGlobal("document", { getElementById: () => null });
    expect(() => readHydration()).toThrow(/server-rendered/);
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

  it("counts a failure as not seeded, and warns in development with the error's name only", async () => {
    const cache = refusing(new Error("invalid snapshot: overlaps"));
    expect(await seedCache(cache, hydration, () => true)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const args = warn.mock.calls[0] ?? [];
    expect(args).toHaveLength(1);
    // The message can quote the snapshot, which carries the page's data.
    expect(args[0]).toContain("(Error)");
    expect(args[0]).not.toContain("invalid snapshot: overlaps");
    expect(args[0]).toContain('"candles"');
  });

  it("names a TscacheError's code beside its name", async () => {
    const error = Object.assign(new TscacheError("refused: 0123"), {
      code: "duplicate",
    });
    expect(await seedCache(refusing(error), hydration, () => true)).toBe(
      undefined,
    );
    expect(warn.mock.calls[0]?.[0]).toContain("(TscacheError duplicate)");
    expect(warn.mock.calls[0]?.[0]).not.toContain("0123");
  });

  it("never quotes a snapshot that is not an object", async () => {
    // decodeSnapshot names a non-object snapshot by its type only (step 146).
    const cache = await cacheOf();
    const spoiled = {
      range: hydration.range,
      snapshot: `${JSON.stringify(hydration.snapshot)}${MARKER}`,
    } as unknown as Hydration;
    expect(await seedCache(cache, spoiled, () => true)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("(TscacheError)");
    expect(warn.mock.calls[0]?.[0]).not.toContain(MARKER);
  });

  it("counts a hydration that is not JSON as not seeded, and never quotes it", async () => {
    // The element is there, so reading it succeeds; its text is parsed only
    // when the seeding reads the snapshot. JSON.parse quotes the text it
    // stopped at.
    const text = JSON.stringify({ range: hydration.range, snapshot: MARKER });
    const broken = text.replace(`"${MARKER}"`, MARKER);
    vi.stubGlobal("document", {
      getElementById: (id: string) =>
        id === "tscache-hydration" ? { textContent: broken } : null,
    });
    const read = readHydration();
    const cache = await cacheOf();
    expect(await seedCache(cache, read, () => true)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("(SyntaxError)");
    expect(warn.mock.calls[0]?.[0]).not.toContain(MARKER);
    // The cache is open and empty: a read fetches all of it.
    const known = await cache.get(hydration.range, { cacheOnly: true });
    expect(known.coverage).toEqual([]);
  });

  it("is silent when the attempt no longer counts, as when its worker was lost", async () => {
    const cache = refusing(new Error("worker lost"));
    expect(await seedCache(cache, hydration, () => false)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("is silent about a client disposed while hydrate was pending", async () => {
    // A pagehide outside the back/forward cache disposes the client, which
    // rejects every pending call with "client disposed" and fires no
    // workerLost, so `live` still holds: the error itself must tell.
    const cache = refusing(new TscacheError("client disposed"));
    expect(await seedCache(cache, hydration, () => true)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("is silent in production", async () => {
    vi.stubEnv("DEV", false);
    const cache = refusing(new Error("invalid snapshot: overlaps"));
    expect(await seedCache(cache, hydration, () => true)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("is silent about a client lost while hydrate was pending", async () => {
    // As the Solid example asks: `live` is whether the client is outside
    // its set of lost clients. A lost worker rejects every pending call,
    // hydrate included, then fires workerLost, which adds the client to the
    // set, all before the rejection reaches seedCache.
    const client = {};
    const lost = new WeakSet<object>();
    let reject: (error: Error) => void = () => {};
    const cache = {
      id: "candles",
      hydrate: () =>
        new Promise<never>((_, fail) => {
          reject = fail;
        }),
    } as unknown as CacheHandle;
    const seeding = seedCache(cache, hydration, () => !lost.has(client));
    reject(new TscacheError("worker lost"));
    lost.add(client);
    expect(await seeding).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});
