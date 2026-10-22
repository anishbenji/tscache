import {
  type CacheConfig,
  type CacheHandle,
  createClient,
  type Dtype,
  type FieldArray,
  type GetResult,
  type Range,
  type TscacheClient,
  TscacheError,
} from "tscache";
import { afterEach, describe, expect, it } from "vitest";
import {
  dehydrate,
  hydrateRead,
  rehydrate,
  type ServerRead,
} from "../shared/hydration";
import { config } from "./helpers";

const open: TscacheClient[] = [];
afterEach(async () => {
  for (const client of open.splice(0)) await client.dispose();
});

/** A read of `range` with its snapshot, as the server reader takes one. */
async function readOf(cache: CacheHandle, range: Range): Promise<ServerRead> {
  const { snapshot, ...result } = await cache.get(range, {
    cacheOnly: true,
    snapshot: true,
  });
  if (snapshot === undefined) throw new Error("no snapshot");
  return { range, result: result as GetResult, snapshot };
}

async function cache() {
  const client = await createClient({ mode: "in-process" });
  open.push(client);
  return client.cache(config);
}

/**
 * The server's read of [0, 50]: final below 40, so covered over [0, 30]
 * with a confirmed gap at 20, and a provisional tail at 40 and 50.
 */
async function serverRead(): Promise<ServerRead> {
  const server = await cache();
  await server.put(
    {
      timestamps: [0, 10, 30, 40, 50],
      fields: { v: [1, Number.NaN, 3, 4, 5], n: [-1, 2, 3, 4, 5] },
      meta: { finalizedUntil: 40 },
    },
    { range: { start: 0, end: 50 } },
  );
  return readOf(server, { start: 0, end: 50 });
}

describe("dehydrate / rehydrate", () => {
  it("brings the read back through JSON as it was, NaN and dtypes included", async () => {
    const read = await serverRead();
    expect(read.result.coverage).toEqual([{ start: 0, end: 30 }]);
    const json = JSON.parse(JSON.stringify(dehydrate(read)));
    const back = rehydrate(config, json);
    expect(back.range).toEqual(read.range);
    expect(back.result.timestamps).toEqual(read.result.timestamps);
    expect(back.result.fields.v).toBeInstanceOf(Float64Array);
    expect(back.result.fields.n).toBeInstanceOf(Int16Array);
    expect(Array.from(back.result.fields.v ?? [])).toEqual([
      1,
      Number.NaN,
      3,
      4,
      5,
    ]);
    expect(Array.from(back.result.fields.n ?? [])).toEqual([-1, 2, 3, 4, 5]);
    expect(back.result.coverage).toEqual(read.result.coverage);
    expect(back.result.misses).toEqual(read.result.misses);
    expect(back.snapshot).toEqual(read.snapshot);
  });

  it("keeps fields named like Object.prototype members as fields", async () => {
    const fields: Record<string, Dtype> = Object.fromEntries([
      ["__proto__", "f64"],
      ["constructor", "i16"],
    ]);
    const odd: CacheConfig = { id: "odd", interval: 10, fields };
    const own = (of: Record<string, FieldArray>, name: string) =>
      Array.from(Object.getOwnPropertyDescriptor(of, name)?.value ?? []);
    const client = await createClient({ mode: "in-process" });
    open.push(client);
    const server = await client.cache(odd);
    const range = { start: 0, end: 10 };
    await server.put(
      {
        timestamps: [0, 10],
        fields: Object.fromEntries([
          ["__proto__", [1.5, 2.5]],
          ["constructor", [3, 4]],
        ]),
      },
      { range },
    );
    const read = await readOf(server, range);
    const back = rehydrate(odd, JSON.parse(JSON.stringify(dehydrate(read))));
    expect(own(back.result.fields, "__proto__")).toEqual([1.5, 2.5]);
    expect(own(back.result.fields, "constructor")).toEqual([3, 4]);

    const other = await createClient({ mode: "in-process" });
    open.push(other);
    const browser = await other.cache(odd);
    await hydrateRead(browser, back);
    const known = await browser.get(range, { cacheOnly: true });
    expect(known.coverage).toEqual([range]);
    expect(own(known.fields, "constructor")).toEqual([3, 4]);
  });

  it("refuses a field the cache config lacks", async () => {
    const value = dehydrate(await serverRead());
    expect(() => rehydrate({ ...config, fields: { v: "f64" } }, value)).toThrow(
      /field n/,
    );
  });
});

describe("hydrateRead", () => {
  it("applies the covered ranges with their gaps, and leaves the provisional tail out", async () => {
    const read = rehydrate(config, dehydrate(await serverRead()));
    const browser = await cache();
    expect(await hydrateRead(browser, read)).toEqual({
      applied: [{ start: 0, end: 30 }],
    });
    const known = await browser.get(read.range, { cacheOnly: true });
    expect(known.coverage).toEqual([{ start: 0, end: 30 }]);
    expect(Array.from(known.timestamps)).toEqual([0, 10, 30]);
    expect(Array.from(known.fields.v ?? [])).toEqual([1, Number.NaN, 3]);
  });

  it("leaves the read usable: its arrays stay and its snapshot seeds another cache", async () => {
    const read = await serverRead();
    await hydrateRead(await cache(), read);
    expect(read.result.timestamps.length).toBe(5);
    expect(read.result.fields.v?.length).toBe(5);
    expect(await hydrateRead(await cache(), read)).toEqual({
      applied: [{ start: 0, end: 30 }],
    });
  });

  it("never replaces what the cache already covers", async () => {
    const read = await serverRead();
    const browser = await cache();
    await browser.put(
      { timestamps: [0, 10], fields: { v: [100, 101], n: [0, 0] } },
      { range: { start: 0, end: 10 } },
    );
    expect(await hydrateRead(browser, read)).toEqual({
      applied: [{ start: 20, end: 30 }],
    });
    const known = await browser.get(read.range, { cacheOnly: true });
    expect(known.coverage).toEqual([{ start: 0, end: 30 }]);
    expect(Array.from(known.timestamps)).toEqual([0, 10, 30]);
    expect(Array.from(known.fields.v ?? [])).toEqual([100, 101, 3]);
  });

  it("applies nothing when the cache covers the whole read", async () => {
    const read = await serverRead();
    const browser = await cache();
    await browser.put(
      { timestamps: [0, 10, 30], fields: { v: [7, 7, 7], n: [7, 7, 7] } },
      { range: { start: 0, end: 30 } },
    );
    expect(await hydrateRead(browser, read)).toEqual({ applied: [] });
    const known = await browser.get(read.range, { cacheOnly: true });
    expect(Array.from(known.fields.v ?? [])).toEqual([7, 7, 7]);
  });

  it("counts an older worker's unknown op as nothing applied, and lets other failures through", async () => {
    const read = await serverRead();
    const refusing = (message: string) =>
      ({
        hydrate: () => Promise.reject(new TscacheError(message)),
      }) as unknown as CacheHandle;
    await expect(
      hydrateRead(refusing("unknown op hydrate"), read),
    ).resolves.toEqual({ applied: [] });
    await expect(
      hydrateRead(refusing("invalid snapshot: interval differs"), read),
    ).rejects.toThrow(/invalid snapshot/);
    // A validation error that merely mentions the phrase is still an error.
    await expect(
      hydrateRead(
        refusing(
          'invalid segment payload: field "v" has dtype unknown op, the schema says f64',
        ),
        read,
      ),
    ).rejects.toThrow(/invalid segment payload/);
  });
});
