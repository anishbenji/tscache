import {
  ConfigError,
  createClient,
  type GetResult,
  type TscacheClient,
} from "tscache";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { type Connection, connect } from "../shared/connection";
import type { ServerRead } from "../shared/hydration";
import { config, type Lossy, lossy, until } from "./helpers";

const open: (Connection | TscacheClient)[] = [];
afterEach(async () => {
  for (const item of open.splice(0)) await item.dispose();
});

/** A connection over lossy clients, and the clients it was given. */
function lossyConnection(seeds: ServerRead[] = []) {
  const clients: Lossy[] = [];
  const connection = connect(
    async () => {
      const next = await lossy();
      clients.push(next);
      return next.client;
    },
    seeds.map((read) => ({ config, read })),
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
