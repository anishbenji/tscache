import {
  type CacheConfig,
  type CacheHandle,
  type ClientOptions,
  ConfigError,
  createClient,
  decodeSnapshot,
  type EncodedSnapshot,
  type GetResult,
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
import { type Connection, connect } from "../shared/connection";
import { dehydrate, rehydrate, type ServerRead } from "../shared/hydration";
import { config, type Lossy, lossy, until } from "./helpers";

const open: (Connection | TscacheClient)[] = [];
afterEach(async () => {
  for (const item of open.splice(0)) await item.dispose();
});

/** How a test's clients are made, beyond the plain lossy client. */
interface Setup {
  /** Options for each client, a fetcher for example. */
  options?: ClientOptions;
  /** The config the seeds were read with; the test's `config` if omitted. */
  seedConfig?: CacheConfig;
  /** Stands in for every handle's `hydrate`, given the real handle. */
  hydrate?: (handle: CacheHandle) => CacheHandle["hydrate"];
}

/** `handle`, except that its `hydrate` is `hydrate`. */
function withHydrate(
  handle: CacheHandle,
  hydrate: CacheHandle["hydrate"],
): CacheHandle {
  return new Proxy(handle, {
    get(target, key) {
      if (key === "hydrate") return hydrate;
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** A connection over lossy clients, and the clients it was given. */
function lossyConnection(seeds: ServerRead[] = [], setup: Setup = {}) {
  const clients: Lossy[] = [];
  const connection = connect(
    async () => {
      const next = await lossy(setup.options);
      clients.push(next);
      const { hydrate } = setup;
      if (hydrate === undefined) return next.client;
      const real = next.client;
      return {
        ...real,
        cache: async (c: CacheConfig) => {
          const handle = await real.cache(c);
          return withHydrate(handle, hydrate(handle));
        },
      };
    },
    seeds.map((read) => ({ config: setup.seedConfig ?? config, read })),
  );
  open.push(connection);
  const connected = () =>
    connection.state.status === "connected" ? connection.state.client : null;
  return { connection, clients, connected };
}

/** A server's read of [0, 20]: points at 0 and 20, a confirmed gap at 10. */
let seed: ServerRead;
beforeAll(async () => {
  const server = await createClient({ mode: "in-process" });
  const cache = await server.cache(config);
  const range = { start: 0, end: 20 };
  await cache.put(
    { timestamps: [0, 20], fields: { v: [1, 2], n: [1, 2] } },
    { range },
  );
  const { snapshot, ...result } = await cache.get(range, {
    cacheOnly: true,
    snapshot: true,
  });
  await server.dispose();
  if (snapshot === undefined) throw new Error("no snapshot");
  seed = { range, result: result as GetResult, snapshot };
});

describe("connect", () => {
  it("connects, and tells subscribers", async () => {
    const { connection, clients } = lossyConnection();
    const seen: string[] = [];
    connection.subscribe(() => seen.push(connection.state.status));
    expect(connection.state.status).toBe("connecting");
    await until(() => connection.state.status === "connected");
    expect(seen).toEqual(["connected"]);
    expect(clients).toHaveLength(1);
  });

  it("replaces a client whose worker is lost", async () => {
    const { connection, clients, connected } = lossyConnection();
    await until(() => connected() !== null);
    const first = connected();
    const seen: string[] = [];
    connection.subscribe(() => seen.push(connection.state.status));
    clients[0]?.lose();
    expect(connection.state.status).toBe("connecting");
    await until(() => connected() !== null);
    expect(connected()).not.toBe(first);
    expect(seen).toEqual(["connecting", "connected"]);
  });

  it("seeds the first client's cache and a replacement's (N39)", async () => {
    const { clients, connection, connected } = lossyConnection([seed]);
    await until(() => connected() !== null);
    const first = await connection.cache(connected() as TscacheClient, config);
    const seeded = await first.get(seed.range, { cacheOnly: true });
    expect(seeded.coverage).toEqual([{ start: 0, end: 20 }]);

    clients[0]?.lose();
    await until(() => connected() !== null);
    const next = await connection.cache(connected() as TscacheClient, config);
    const reseeded = await next.get(seed.range, { cacheOnly: true });
    expect(reseeded.coverage).toEqual([{ start: 0, end: 20 }]);
  });

  it("seeds a replacement when the first client is lost before opening the cache", async () => {
    const { clients, connection, connected } = lossyConnection([seed]);
    await until(() => connected() !== null);
    clients[0]?.lose();
    await until(() => connected() !== null);
    const next = await connection.cache(connected() as TscacheClient, config);
    const seeded = await next.get(seed.range, { cacheOnly: true });
    expect(seeded.coverage).toEqual([{ start: 0, end: 20 }]);
  });

  it("seeds a cache once per client under concurrent calls", async () => {
    const { connection, connected } = lossyConnection([seed]);
    await until(() => connected() !== null);
    const client = connected() as TscacheClient;
    const [a, b] = await Promise.all([
      connection.cache(client, config),
      connection.cache(client, config),
    ]);
    await a.put(
      { timestamps: [0], fields: { v: [9], n: [9] } },
      { range: { start: 0, end: 0 } },
    );
    // A second seeding would have put 1 at 0 again over this 9.
    await connection.cache(client, config);
    const known = await b.get(seed.range, { cacheOnly: true });
    expect(Array.from(known.fields.v ?? [])).toEqual([9, 2]);
  });

  it("lets the client refuse a config that conflicts with the open one (N4)", async () => {
    const { connection, connected } = lossyConnection();
    await until(() => connected() !== null);
    const client = connected() as TscacheClient;
    await connection.cache(client, config);
    await expect(
      connection.cache(client, { ...config, interval: 20 }),
    ).rejects.toThrow(ConfigError);
  });

  it("refuses a conflicting config asked for while the first still opens", async () => {
    const { connection, connected } = lossyConnection([seed]);
    await until(() => connected() !== null);
    const client = connected() as TscacheClient;
    const first = connection.cache(client, config);
    const conflict = connection.cache(client, { ...config, interval: 20 });
    await expect(conflict).rejects.toThrow(ConfigError);
    await expect(first).resolves.toBeDefined();
  });

  it("opens an equal config given as another object, after the seed", async () => {
    const { connection, connected } = lossyConnection([seed]);
    await until(() => connected() !== null);
    const client = connected() as TscacheClient;
    const first = connection.cache(client, config);
    const twin = await connection.cache(client, { ...config });
    const known = await twin.get(seed.range, { cacheOnly: true });
    expect(known.coverage).toEqual([{ start: 0, end: 20 }]);
    await first;
  });

  it("lets the client judge a config changed in place after its open", async () => {
    const { connection, connected } = lossyConnection();
    await until(() => connected() !== null);
    const client = connected() as TscacheClient;
    const changing = { ...config };
    await connection.cache(client, changing);
    changing.interval = 5;
    await expect(connection.cache(client, changing)).rejects.toThrow(
      ConfigError,
    );
  });

  it("puts a seed with the config it was read with, never another", async () => {
    const { connection, connected } = lossyConnection([seed]);
    await until(() => connected() !== null);
    const client = connected() as TscacheClient;
    await expect(
      connection.cache(client, { ...config, interval: 5 }),
    ).rejects.toThrow(ConfigError);
    const seeded = await connection.cache(client, config);
    const known = await seeded.get(seed.range, { cacheOnly: true });
    expect(known.coverage).toEqual([{ start: 0, end: 20 }]);
  });

  it("a failed open does not stick to the cache id", async () => {
    const { connection, connected } = lossyConnection();
    await until(() => connected() !== null);
    const client = connected() as TscacheClient;
    const bad = { ...config, interval: -1 };
    await expect(connection.cache(client, bad)).rejects.toThrow(ConfigError);
    await expect(connection.cache(client, config)).resolves.toBeDefined();
  });

  it("reports a client that cannot connect", async () => {
    const connection = connect(() => Promise.reject(new Error("no worker")));
    open.push(connection);
    await until(() => connection.state.status === "failed");
    const { state } = connection;
    expect(state.status === "failed" && state.error).toEqual(
      new Error("no worker"),
    );
  });

  it("disposes the client, and stops telling subscribers", async () => {
    const { connection, clients, connected } = lossyConnection();
    await until(() => connected() !== null);
    const client = connected() as TscacheClient;
    let calls = 0;
    connection.subscribe(() => calls++);
    await connection.dispose();
    await expect(client.cache(config)).rejects.toThrow();
    clients[0]?.lose();
    // clock-ok: an absence check; a slow machine can only hide a late call, not fail the test.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toBe(0);
    expect(clients).toHaveLength(1);
  });

  it("disposes a client that arrives after dispose()", async () => {
    let release: (client: TscacheClient) => void = () => {};
    const connection = connect(
      () => new Promise<TscacheClient>((resolve) => (release = resolve)),
    );
    await connection.dispose();
    const late = await lossy();
    release(late.client);
    // clock-ok: a turn of the event loop, not a wait for time.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(late.client.cache(config)).rejects.toThrow();
    expect(connection.state.status).toBe("connecting");
  });
});

// Decision 98 C (2026-11-21): a seed that fails to apply means "not seeded".
// The client still hands out the cache, which fetches what the seed would
// have filled, and a development build says why in one warning.
describe("connect, when a seed fails to apply", () => {
  /** Every range the fetcher was asked for. */
  const fetched: Range[] = [];
  const fetcher = `data:text/javascript,${encodeURIComponent(`
    export default {
      async fetch({ range }) {
        globalThis.__seedFetches.push(range);
        const timestamps = [];
        for (let t = range.start; t <= range.end; t += 10) timestamps.push(t);
        const values = timestamps.map(() => 7);
        return { timestamps, fields: { v: values, n: values } };
      },
    };
  `)}`;
  const options: ClientOptions = { fetcher: { module: fetcher } };

  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetched.length = 0;
    vi.stubGlobal("__seedFetches", fetched);
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("NODE_ENV", "development");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /**
   * The seed with its one segment given twice: rules 1 to 4 of hydrate's
   * validation pass and the first payload is accepted, then the second
   * fails, as its extent overlaps the first (architecture §8, N35).
   */
  function corrupt(): ServerRead {
    const [first] = seed.snapshot.segments;
    if (first === undefined) throw new Error("the seed has no segment");
    return {
      ...seed,
      snapshot: { ...seed.snapshot, segments: [first, first] },
    };
  }

  /** The error an empty cache's `hydrate` gives for `read`'s snapshot. */
  async function refusal(read: ServerRead): Promise<Error> {
    const client = await createClient({ mode: "in-process" });
    open.push(client);
    const cache = await client.cache(config);
    const error: unknown = await cache.hydrate(read.snapshot).then(
      () => undefined,
      (e: unknown) => e,
    );
    if (!(error instanceof TscacheError)) throw new Error("it applied");
    return error;
  }

  it("hands out the cache with nothing of a snapshot that fails validation part way, and the cache fetches", async () => {
    const read = corrupt();
    const { connection, connected } = lossyConnection([read], { options });
    await until(() => connected() !== null);
    const handle = await connection.cache(connected() as TscacheClient, config);
    const known = await handle.get(seed.range, { cacheOnly: true });
    expect(known.coverage).toEqual([]);
    expect(Array.from(known.timestamps)).toEqual([]);
    expect(fetched).toEqual([]);

    const answer = await handle.get(seed.range);
    expect(fetched).toEqual([seed.range]);
    expect(Array.from(answer.timestamps)).toEqual([0, 10, 20]);
    expect(Array.from(answer.fields.v ?? [])).toEqual([7, 7, 7]);
  });

  it("warns once in development with the error's name, and neither its message nor the snapshot", async () => {
    const read = corrupt();
    const { message, name } = await refusal(read);
    expect(message).toMatch(/^invalid snapshot/);
    const { connection, connected } = lossyConnection([read], { options });
    await until(() => connected() !== null);
    await connection.cache(connected() as TscacheClient, config);

    expect(warn).toHaveBeenCalledTimes(1);
    // One string: neither the snapshot nor the error object, whose fields a
    // console would print, goes to the console; nor the message, which can
    // quote the snapshot.
    const args = warn.mock.calls[0] ?? [];
    expect(args).toHaveLength(1);
    const [text] = args;
    expect(typeof text).toBe("string");
    expect(text).toContain(`(${name})`);
    expect(text).not.toContain(message);
    expect(text).toContain(`"${config.id}"`);
  });

  it("never quotes a snapshot whose error would quote it", async () => {
    // decodeSnapshot quotes a snapshot that is not an object whole.
    const marker = "SECRETMARKER";
    const value = dehydrate(seed);
    const spoiled = `${JSON.stringify(value.snapshot)}${marker}`;
    let message = "";
    try {
      decodeSnapshot(spoiled as unknown as EncodedSnapshot);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(marker);

    const read = rehydrate(config, {
      ...value,
      snapshot: spoiled as unknown as EncodedSnapshot,
    });
    const { connection, connected } = lossyConnection([read], { options });
    await until(() => connected() !== null);
    const handle = await connection.cache(connected() as TscacheClient, config);
    const answer = await handle.get(seed.range);
    expect(fetched).toEqual([seed.range]);
    expect(Array.from(answer.fields.v ?? [])).toEqual([7, 7, 7]);
    expect(warn).toHaveBeenCalledTimes(1);
    const [text] = warn.mock.calls[0] ?? [];
    expect(text).toContain("(TscacheError)");
    expect(text).not.toContain(marker);
  });

  it("is silent in production, and still hands out the cache", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { connection, connected } = lossyConnection([corrupt()], {
      options,
    });
    await until(() => connected() !== null);
    const handle = await connection.cache(connected() as TscacheClient, config);
    await handle.get(seed.range);
    expect(fetched).toEqual([seed.range]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("counts a worker without hydrate as not seeded, silently, as before", async () => {
    const { connection, connected } = lossyConnection([seed], {
      options,
      hydrate: () => () =>
        Promise.reject(new TscacheError("unknown op hydrate")),
    });
    await until(() => connected() !== null);
    const handle = await connection.cache(connected() as TscacheClient, config);
    const answer = await handle.get(seed.range);
    expect(fetched).toEqual([seed.range]);
    expect(Array.from(answer.fields.v ?? [])).toEqual([7, 7, 7]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("applies and warns once per client and cache, however often the cache is asked for", async () => {
    let applies = 0;
    const { clients, connection, connected } = lossyConnection([corrupt()], {
      options,
      hydrate: (handle) => (snapshot) => {
        applies++;
        return handle.hydrate(snapshot);
      },
    });
    await until(() => connected() !== null);
    const client = connected() as TscacheClient;
    await Promise.all([
      connection.cache(client, config),
      connection.cache(client, config),
    ]);
    await connection.cache(client, config);
    expect(applies).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);

    // A replacement client is a new client: its cache is seeded afresh.
    clients[0]?.lose();
    await until(() => connected() !== null && connected() !== client);
    await connection.cache(connected() as TscacheClient, config);
    expect(applies).toBe(2);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("is silent when the worker is lost while the seed applies, and the replacement seeds", async () => {
    let applies = 0;
    let reject: ((error: Error) => void) | undefined;
    const { clients, connection, connected } = lossyConnection([seed], {
      options,
      hydrate: (handle) => (snapshot) => {
        applies++;
        if (applies > 1) return handle.hydrate(snapshot);
        return new Promise<never>((_, fail) => {
          reject = fail;
        });
      },
    });
    await until(() => connected() !== null);
    const first = connected() as TscacheClient;
    const asked = connection.cache(first, config);
    await until(() => reject !== undefined);
    // As the port client does when its worker is lost: it rejects every
    // pending call, then fires workerLost (rpc/port-client.ts).
    reject?.(new TscacheError("worker lost"));
    clients[0]?.lose();
    await expect(asked).rejects.toThrow("worker lost");
    expect(warn).not.toHaveBeenCalled();

    await until(() => connected() !== null && connected() !== first);
    const next = await connection.cache(connected() as TscacheClient, config);
    expect(applies).toBe(2);
    const seeded = await next.get(seed.range, { cacheOnly: true });
    expect(seeded.coverage).toEqual([{ start: 0, end: 20 }]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("is silent when the connection is disposed while the seed applies", async () => {
    let reject: ((error: Error) => void) | undefined;
    const { connection, connected } = lossyConnection([seed], {
      options,
      hydrate: () => () =>
        new Promise<never>((_, fail) => {
          reject = fail;
        }),
    });
    await until(() => connected() !== null);
    const asked = connection.cache(connected() as TscacheClient, config);
    await until(() => reject !== undefined);
    await connection.dispose();
    reject?.(new TscacheError("client disposed"));
    await asked.catch(() => {});
    expect(warn).not.toHaveBeenCalled();
  });

  it("is silent when the application disposes the client while the seed applies", async () => {
    let reject: ((error: Error) => void) | undefined;
    const { connection, connected } = lossyConnection([seed], {
      options,
      hydrate: () => () =>
        new Promise<never>((_, fail) => {
          reject = fail;
        }),
    });
    await until(() => connected() !== null);
    const client = connected() as TscacheClient;
    const asked = connection.cache(client, config);
    await until(() => reject !== undefined);
    // As the port client does on dispose(): every pending call rejects, and
    // no workerLost follows, so the connection still holds the client.
    await client.dispose();
    reject?.(new TscacheError("client disposed"));
    await expect(asked).rejects.toThrow("client disposed");
    expect(connection.state.status).toBe("connected");
    expect(warn).not.toHaveBeenCalled();
  });

  it("still rejects when the seed's cache cannot be opened", async () => {
    const { connection, connected } = lossyConnection([seed], {
      options,
      seedConfig: { ...config, interval: -1 },
    });
    await until(() => connected() !== null);
    const client = connected() as TscacheClient;
    await expect(connection.cache(client, config)).rejects.toThrow(ConfigError);
    await expect(connection.cache(client, config)).rejects.toThrow(ConfigError);
    expect(warn).not.toHaveBeenCalled();
  });

  // A page's read goes through `rehydrate` before `connect`: a snapshot that
  // `decodeSnapshot` refuses must not stop the page there.
  it.each([
    {
      what: "a format the library does not know",
      spoil: (s: EncodedSnapshot): unknown => ({ ...s, format: 3 }),
    },
    {
      what: "a mask that is not base64",
      spoil: (s: EncodedSnapshot): unknown => ({
        ...s,
        segments: s.segments.map((p) => ({ ...p, mask: "!" })),
      }),
    },
  ])(
    "counts a snapshot with $what as not seeded, and the cache fetches",
    async ({ spoil }) => {
      const value = dehydrate(seed);
      const spoiled = spoil(value.snapshot) as EncodedSnapshot;
      let message = "";
      try {
        decodeSnapshot(spoiled);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe("");

      const read = rehydrate(config, { ...value, snapshot: spoiled });
      const { connection, connected } = lossyConnection([read], { options });
      await until(() => connected() !== null);
      const handle = await connection.cache(
        connected() as TscacheClient,
        config,
      );
      const answer = await handle.get(seed.range);
      expect(fetched).toEqual([seed.range]);
      expect(Array.from(answer.fields.v ?? [])).toEqual([7, 7, 7]);
      expect(warn).toHaveBeenCalledTimes(1);
      // The error's name, never its message, which can quote the snapshot.
      expect(warn.mock.calls[0]?.[0]).toContain("(TscacheError)");
      expect(warn.mock.calls[0]?.[0]).not.toContain(message);
    },
  );
});
