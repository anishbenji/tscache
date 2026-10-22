import {
  type CacheConfig,
  createClient,
  type Dtype,
  type FieldArray,
  type TscacheClient,
} from "tscache";
import { afterEach, describe, expect, it } from "vitest";
import {
  dehydrate,
  putCovered,
  rehydrate,
  type ServerRead,
} from "../shared/hydration";
import { config } from "./helpers";

const open: TscacheClient[] = [];
afterEach(async () => {
  for (const client of open.splice(0)) await client.dispose();
});

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
  const range = { start: 0, end: 50 };
  return { range, result: await server.get(range, { cacheOnly: true }) };
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
    const read = { range, result: await server.get(range) };
    const back = rehydrate(odd, JSON.parse(JSON.stringify(dehydrate(read))));
    expect(own(back.result.fields, "__proto__")).toEqual([1.5, 2.5]);
    expect(own(back.result.fields, "constructor")).toEqual([3, 4]);

    const other = await createClient({ mode: "in-process" });
    open.push(other);
    const browser = await other.cache(odd);
    await putCovered(browser, odd, back);
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

describe("putCovered", () => {
  it("puts the covered ranges with their gaps, and leaves the provisional tail out", async () => {
    const read = rehydrate(config, dehydrate(await serverRead()));
    const browser = await cache();
    await putCovered(browser, config, read);
    const known = await browser.get(read.range, { cacheOnly: true });
    expect(known.coverage).toEqual([{ start: 0, end: 30 }]);
    expect(Array.from(known.timestamps)).toEqual([0, 10, 30]);
    expect(Array.from(known.fields.v ?? [])).toEqual([1, Number.NaN, 3]);
  });

  it("keeps the read's arrays usable: it puts copies", async () => {
    const read = await serverRead();
    await putCovered(await cache(), config, read);
    expect(read.result.timestamps.length).toBe(5);
    expect(read.result.fields.v?.length).toBe(5);
  });

  it("never replaces what the cache already covers", async () => {
    const read = await serverRead();
    const browser = await cache();
    await browser.put(
      { timestamps: [0, 10], fields: { v: [100, 101], n: [0, 0] } },
      { range: { start: 0, end: 10 } },
    );
    await putCovered(browser, config, read);
    const known = await browser.get(read.range, { cacheOnly: true });
    expect(known.coverage).toEqual([{ start: 0, end: 30 }]);
    expect(Array.from(known.timestamps)).toEqual([0, 10, 30]);
    expect(Array.from(known.fields.v ?? [])).toEqual([100, 101, 3]);
  });

  it("puts nothing when the cache covers the whole read", async () => {
    const read = await serverRead();
    const browser = await cache();
    await browser.put(
      { timestamps: [0, 10, 30], fields: { v: [7, 7, 7], n: [7, 7, 7] } },
      { range: { start: 0, end: 30 } },
    );
    await putCovered(browser, config, read);
    const known = await browser.get(read.range, { cacheOnly: true });
    expect(Array.from(known.fields.v ?? [])).toEqual([7, 7, 7]);
  });
});
