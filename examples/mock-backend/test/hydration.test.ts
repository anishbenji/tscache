import { type CacheConfig, createClient, type TscacheClient } from "tscache";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dehydrate,
  type Hydration,
  hydrationScript,
  putSeeds,
  readHydration,
} from "../src/hydration";

const MINUTE = 60_000;
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
    await putSeeds(browser, config, roundTrip(dehydrate(range, answer)));
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

  it("seeds each covered range with its own points", async () => {
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
    const hydration = dehydrate(range, await server.get(range));
    expect(hydration.seeds.map((seed) => seed.range)).toEqual([
      { start: at(0), end: at(2) },
      { start: at(5), end: at(7) },
    ]);

    const browser = await cacheOf();
    await putSeeds(browser, config, roundTrip(hydration));
    const planted = await browser.get(range);
    expect(planted.coverage).toEqual(hydration.seeds.map((seed) => seed.range));
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
    const hydration = dehydrate(range, await server.get(range));

    // Another tab's fetch already covered slots 2–3, with later values.
    const browser = await cacheOf();
    await browser.put(
      {
        timestamps: [at(2), at(3)],
        fields: { value: [9, 9], level: [9, 9], battery: [9, 9] },
      },
      { range: { start: at(2), end: at(3) } },
    );
    await putSeeds(browser, config, roundTrip(hydration));
    const planted = await browser.get(range);
    expect(planted.coverage).toEqual([range]);
    expect([...(planted.fields.value ?? [])]).toEqual([1, 1, 9, 9, 1, 1]);
  });

  it("escapes < so no value can close the script element", () => {
    const hydration: Hydration = {
      range: { start: 0, end: 0 },
      seeds: [
        {
          range: { start: 0, end: 0 },
          timestamps: "",
          fields: { "</script><b>": "" },
        },
      ],
    };
    const html = hydrationScript(hydration);
    expect(html.indexOf("</script>")).toBe(html.length - "</script>".length);
    expect(roundTrip(hydration)).toEqual(hydration);
  });

  it("says so when the page carries no hydration", () => {
    vi.stubGlobal("document", { getElementById: () => null });
    expect(() => readHydration()).toThrow(/server-rendered/);
  });
});
