import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient, type TscacheClient } from "../src/client/client";
import { nextSlotStart, slotStart, snapRange } from "../src/entries/grid";
import { ConfigError, InvalidRangeError } from "../src/errors";
import {
  createCalendarGrid,
  floorSlot,
  type Grid,
  snapOut,
  startOf,
  toMs,
} from "../src/grid";
import { PROTOCOL_VERSION, type Req } from "../src/rpc/protocol";
import type { CacheConfig, CalendarInterval } from "../src/types";
import { rng } from "./cache-model";

// Implementer tests for the calendar grid's page side (design §9 tests 18
// and 19; architecture §2.10, N116, N119).

const DAY = 86_400_000;
const open: TscacheClient[] = [];

afterEach(async () => {
  for (const client of open.splice(0)) await client.dispose();
  vi.unstubAllGlobals();
});

const calendars: CalendarInterval[] = [
  { unit: "day", zone: "America/New_York", at: "09:30" },
  { unit: "day" },
  { unit: "week", zone: "Europe/London", weekStart: 7 },
  { unit: "month", zone: "Asia/Kathmandu", at: "18:15" },
  { unit: "quarter" },
  { unit: "year", zone: "Pacific/Apia" },
];

describe("the grid entry (test 18)", () => {
  it.each(calendars)(
    "equals the engine's outward snap and slot starts on $unit in $zone",
    (interval) => {
      const grid = createCalendarGrid(interval);
      const random = rng(129_018);
      for (let i = 0; i < 300; i++) {
        // Settled years: the zones' rules there are the same in every runtime.
        const start = random.int(Date.UTC(1971, 0, 1), Date.UTC(2026, 0, 1));
        const end = start + random.int(0, 800 * DAY);
        const range = { start, end };
        expect(snapRange(range, interval)).toEqual(
          toMs(snapOut(range, grid), grid),
        );
        const slot = floorSlot(start, grid);
        expect(slotStart(start, interval)).toBe(startOf(slot, grid));
        expect(nextSlotStart(start, interval)).toBe(startOf(slot + 1, grid));
        // A slot start is its own slot's start, and the next one is later.
        const at = slotStart(start, interval);
        expect(slotStart(at, interval)).toBe(at);
        expect(nextSlotStart(at, interval)).toBeGreaterThan(at);
        expect(slotStart(nextSlotStart(at, interval) - 1, interval)).toBe(at);
      }
    },
  );

  it("equals the engine's outward snap and slot starts on fixed grids", () => {
    const random = rng(129_118);
    for (let i = 0; i < 2000; i++) {
      const interval = random.pick([1, 7, 60_000, DAY, 2 ** 40]);
      const offset = random.int(-3 * interval, 3 * interval);
      const normal = ((offset % interval) + interval) % interval;
      const grid: Grid = { interval, alignmentOffset: normal };
      const start = random.int(-(2 ** 45), 2 ** 45);
      const range = { start, end: start + random.int(0, 2 ** 42) };
      expect(snapRange(range, interval, offset)).toEqual(
        toMs(snapOut(range, grid), grid),
      );
      const slot = floorSlot(start, grid);
      expect(slotStart(start, interval, offset)).toBe(startOf(slot, grid));
      expect(nextSlotStart(start, interval, offset)).toBe(
        startOf(slot + 1, grid),
      );
    }
    // The offset is optional, and 0 without it.
    expect(snapRange({ start: 1, end: 11 }, 10)).toEqual({ start: 0, end: 20 });
    expect(slotStart(19, 10)).toBe(10);
    expect(nextSlotStart(20, 10)).toBe(30);
  });

  it("rejects what a cache config or a cache read would reject", () => {
    const range = { start: 0, end: 10 };
    for (const interval of [0, -1, 1.5, Number.NaN, "60000"]) {
      expect(() => snapRange(range, interval as number)).toThrow(ConfigError);
    }
    expect(() => snapRange(range, 10, 0.5)).toThrow(ConfigError);
    expect(() => slotStart(0, { unit: "hour" } as never)).toThrow(ConfigError);
    expect(() => nextSlotStart(0, { unit: "day", zone: "No/Zone" })).toThrow(
      ConfigError,
    );
    expect(() => snapRange(range, { unit: "day" }, 5)).toThrow(ConfigError);
    expect(() => snapRange({ start: 10, end: 0 }, 10)).toThrow(
      InvalidRangeError,
    );
    // An instant is checked as a range's end is, on both kinds of grid
    // (§2.10): not a finite number within ±(2^53 − 1), no slot.
    const max = Number.MAX_SAFE_INTEGER;
    for (const interval of [10, { unit: "day" }] as const) {
      for (const t of [Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, "5"]) {
        expect(() => slotStart(t as number, interval)).toThrow(
          InvalidRangeError,
        );
        expect(() => nextSlotStart(t as number, interval)).toThrow(
          InvalidRangeError,
        );
      }
    }
    // A fixed grid's slot whose start, or whose next start, is no safe
    // integer has none to return.
    expect(() => slotStart(-max, 10)).toThrow(InvalidRangeError);
    expect(() => nextSlotStart(-max, 10)).toThrow(InvalidRangeError);
    expect(() => nextSlotStart(max - 1, 10)).toThrow(InvalidRangeError);
    expect(slotStart(max - 1, 10)).toBe(max - 1);
    expect(slotStart(max, 10)).toBe(max - 1);
    expect(nextSlotStart(max - 12, 10)).toBe(max - 11);
    expect(slotStart(-max + 1, 10)).toBe(-max + 1);
    // A calendar's last slot has a next start, the end of the domain.
    expect(nextSlotStart(Date.UTC(9999, 11, 31, 12), { unit: "day" })).toBe(
      Date.UTC(9999, 11, 31) + 86_400_000,
    );
    // Outside a calendar's domain, the years 1 to 9999.
    expect(() => slotStart(Date.UTC(12_000, 0, 1), { unit: "day" })).toThrow(
      InvalidRangeError,
    );
  });
});

/**
 * A worker whose hello lists `features`, recording every request: it
 * answers the cache op with its config, as a resolved one.
 */
function installWorker(features: string[] | undefined): Req[] {
  const received: Req[] = [];
  vi.stubGlobal("Worker", undefined);
  vi.stubGlobal(
    "SharedWorker",
    class {
      port: unknown;
      constructor() {
        const channel = new MessageChannel();
        const worker = channel.port1;
        worker.addEventListener("message", (event) => {
          const message = event.data as Req | { t: "init" };
          if (message.t === "init") worker.postMessage({ t: "init-ok" });
          if (message.t !== "req") return;
          received.push(message);
          worker.postMessage({
            t: "res",
            id: message.id,
            ok: true,
            result: message.params,
          });
        });
        worker.start();
        worker.postMessage({
          t: "hello",
          protocol: PROTOCOL_VERSION,
          lib: "0.2.0",
          clientId: "c1",
          ...(features === undefined ? {} : { features }),
        });
        this.port = channel.port2;
      }
      addEventListener() {}
      removeEventListener() {}
    },
  );
  return received;
}

async function client(
  options: Parameters<typeof createClient>[0],
): Promise<TscacheClient> {
  const created = await createClient(options);
  open.push(created);
  return created;
}

const calendar: CacheConfig = {
  id: "daily",
  interval: { unit: "day", zone: "America/New_York", at: "09:30" },
  fields: { value: "f64" },
};
const fixed: CacheConfig = {
  id: "fixed",
  interval: 60_000,
  fields: { value: "f64" },
};

describe("the 'calendar-grid' feature (test 19, N119)", () => {
  it("this package's worker lists it and takes a calendar config", async () => {
    const c = await client({ mode: "in-process" });
    expect(c.features.has("calendar-grid")).toBe(true);
    const cache = await c.cache(calendar);
    const open = Date.UTC(2026, 2, 9, 13, 30);
    await cache.put({ timestamps: [open], fields: { value: [1] } });
    const read = await cache.get({ start: open, end: open });
    expect(read.timestamps).toEqual(new Float64Array([open]));
  });

  it.each([
    { name: "a hello without features", features: undefined },
    { name: "a hello that lists other features", features: ["cacheChanged"] },
  ])(
    "against $name, a calendar config is refused before anything is posted",
    async ({ features }) => {
      const received = installWorker(features);
      const c = await client({ workerUrl: "/dist/worker.js" });
      expect(c.features.has("calendar-grid")).toBe(false);
      const refused = c.cache(calendar);
      await expect(refused).rejects.toBeInstanceOf(ConfigError);
      await expect(refused).rejects.toThrow(/calendar-grid/);
      // An ordered answer on the same port: the fixed config that follows
      // is the only request the worker received.
      await c.cache(fixed);
      expect(received.map(({ op, params }) => [op, params])).toEqual([
        ["cache", fixed],
      ]);
    },
  );
});
