import { expect, it } from "vitest";
import { isAligned, slotAtOrAfter, slotOf } from "../src/grid";
import { Persister } from "../src/persist/persister";
import type { CalendarSnapshot, Range, Snapshot } from "../src/types";
import { rng } from "./cache-model";
import {
  addCache,
  batch,
  calendarGrid,
  DAY,
  daySlot,
  engine,
  expectTscacheError,
  format2,
  HOUR,
  hydrate,
  ID,
  miss,
  NY,
  nyOffset,
  persisted,
  probe,
  resolveCalendarStart,
  slots,
  span,
  startOf,
  utc,
} from "./calendar-contract-helpers";
import { fakeTime, finish, tick } from "./persist-harness";
import { MemoryStore } from "./persist-memory-store";
import { requireCache } from "./persist-test-helpers";

fakeTime();

const daily = { unit: "day", zone: NY, at: "09:30" } as const;
const winter = () => -5 * HOUR;
const dailyStart = (slot: number) => slot * DAY + 14.5 * HOUR;
const cap = 512;
const block = 40 * cap;
const points = (first: number, count: number) =>
  slots(first, first + count - 1).map(dailyStart);
const hull = (timestamps: number[]) =>
  span(timestamps[0] as number, timestamps.at(-1) as number);

it.each([
  ["2026-03-08T09:30Z", "2026-03-08T13:30Z"],
  ["2026-11-01T09:30Z", "2026-11-01T14:30Z"],
  ["2026-03-08T02:30Z", "2026-03-08T07:30Z"],
  ["2026-11-01T01:30Z", "2026-11-01T05:30Z"],
])(
  "17: G6 resolves %s to %s with at most three offset calls",
  (nominal, expected) => {
    const { context, lookups } = probe(nyOffset);
    const g = calendarGrid(daily, context);
    expect(resolveCalendarStart(utc(nominal), g)).toBe(utc(expected));
    expect(lookups.length).toBeGreaterThan(0);
    expect(lookups.length).toBeLessThanOrEqual(3);
  },
);

it.each([
  { date: "2026-03-07", start: "2026-03-07T14:30Z" },
  { date: "2026-03-08", start: "2026-03-08T13:30Z" },
  { date: "2026-11-01", start: "2026-11-01T14:30Z" },
])(
  "17: a cold start and aligned or unaligned conversions have bounded calls on $date",
  ({ date, start }) => {
    const { context, lookups } = probe(nyOffset);
    const g = calendarGrid(daily, context);
    const slot = daySlot(date);
    const t = utc(start);
    expect(startOf(slot, g)).toBe(t);
    expect(lookups.length).toBeGreaterThan(0);
    expect(lookups.length).toBeLessThanOrEqual(6);
    for (const operation of [
      () => expect(isAligned(t, g)).toBe(true),
      () => expect(isAligned(t + 1, g)).toBe(false),
      () => expect(slotOf(t, g)).toBe(slot),
      () => expect(() => slotOf(t + 1, g)).toThrow(RangeError),
      () => expect(slotAtOrAfter(t, g)).toBe(slot),
      () => expect(slotAtOrAfter(t - 1, g)).toBe(slot),
      () => expect(slotAtOrAfter(t + 1, g)).toBe(slot + 1),
    ]) {
      lookups.length = 0;
      operation();
      expect(lookups.length).toBeGreaterThan(0);
      expect(lookups.length).toBeLessThanOrEqual(12);
    }
    expect(context.tableCount).toBe(0);
  },
);

it.each([255, 256, 257])(
  "17: a put of %i starts in a block obeys the strict half-block threshold",
  (count) => {
    const { context, lookups } = probe(winter);
    const e = engine(daily, {}, context);
    const timestamps = points(block + 20, count);
    e.put(ID, batch(timestamps));
    expect(lookups.length).toBeGreaterThan(0);
    expect(context.tableCount).toBe(count > cap / 2 ? 1 : 0);
    if (count > cap / 2) expect(lookups.length).toBeLessThanOrEqual(3 * 513);
    lookups.length = 0;
    expect(e.get(ID, hull(timestamps)).timestamps).toEqual(
      new Float64Array(timestamps),
    );
    if (count > cap / 2) expect(lookups).toEqual([]);
    else expect(context.tableCount).toBe(0);
  },
);

it("17: equal descriptors share tables, different descriptors fill their own, and clear leaves both", () => {
  const { context, lookups } = probe(winter);
  const e = engine(daily, {}, context);
  addCache(e, { unit: "day", zone: NY, at: "09:30" }, { id: "equal" });
  addCache(e, { ...daily, at: "09:31" }, { id: "different" });
  const timestamps = points(block + 20, 257);
  e.put(ID, batch(timestamps));

  lookups.length = 0;
  e.put("equal", batch(timestamps));
  expect(e.get("equal", hull(timestamps)).timestamps).toEqual(
    new Float64Array(timestamps),
  );
  expect(lookups).toEqual([]);
  expect(context.tableCount).toBe(1);

  const shifted = timestamps.map((t) => t + 60_000);
  e.put("different", batch(shifted));
  expect(lookups.length).toBeGreaterThan(0);
  expect(context.tableCount).toBe(2);
  e.clear(ID);
  e.clearAll();
  expect(context.tableCount).toBe(2);
  lookups.length = 0;
  expect(e.get(ID, hull(timestamps)).timestamps).toHaveLength(0);
  e.put(ID, batch(timestamps));
  expect(lookups).toEqual([]);
});

it("17: reads across more blocks than the capacity keep only the most recently used tables", () => {
  const { context, lookups } = probe(winter, { tableCapacity: 2 });
  const writer = engine(daily, {}, probe(winter).context);
  const ranges: Range[] = [];
  for (let n = 0; n < 3; n++) {
    const timestamps = points(block + n * cap + 20, 257);
    writer.put(ID, batch(timestamps));
    ranges.push(hull(timestamps));
  }
  const [first, second, third] = ranges as [Range, Range, Range];
  const reader = engine(daily, {}, context);
  hydrate(reader, writer.snapshot(ID, span(first.start, third.end)));
  expect(context.tableCount).toBe(0);
  for (const range of ranges) {
    expect(reader.get(ID, range).timestamps).toHaveLength(257);
    expect(context.tableCount).toBeLessThanOrEqual(2);
  }
  expect(context.tableCount).toBe(2);
  lookups.length = 0;
  reader.get(ID, third);
  reader.get(ID, second);
  expect(lookups).toEqual([]);
  reader.get(ID, first);
  expect(lookups.length).toBeGreaterThan(0);
  expect(context.tableCount).toBe(2);
});

it("17: point eviction leaves the descriptor's table warm", () => {
  const { context, lookups } = probe(winter);
  const e = engine(daily, {}, context, { memoryBudget: 1 });
  const timestamps = points(block + 20, 257);
  e.put(ID, batch(timestamps));
  expect(e.memoryStats().evictedPages).toBe(1);
  expect(context.tableCount).toBe(1);
  lookups.length = 0;
  expect(e.get(ID, hull(timestamps)).timestamps).toHaveLength(0);
  expect(lookups).toEqual([]);
});

it("17: the fixed and UTC grids never call the offset seam", () => {
  const { context, lookups } = probe(winter);
  for (const interval of [DAY, { unit: "day", zone: "UTC" }] as const) {
    const e = engine(interval, {}, context);
    const timestamps = slots(block + 20, block + 20 + 256).map((k) => k * DAY);
    e.put(ID, batch(timestamps));
    const range = hull(timestamps);
    expect(e.get(ID, range).timestamps).toEqual(new Float64Array(timestamps));
    const snapshot = e.snapshot(ID, range);
    const receiver = engine(interval, {}, context);
    expect(hydrate(receiver, snapshot)).toEqual({ applied: [range] });
  }
  expect(lookups).toEqual([]);
  expect(context.tableCount).toBe(0);
});

function charge(snapshot: Snapshot): number {
  return (
    24 +
    36 * snapshot.coverage.length +
    12 * snapshot.segments.length +
    (snapshot.finalizedUntil === undefined ? 0 : 12)
  );
}

async function checkRecordCost(
  ranges: Range[],
  data: number[][],
  offset = winter,
  expectedSegments?: number,
): Promise<void> {
  const writer = engine(daily, { persist: true }, probe(offset).context);
  const source = await persisted(writer);
  for (const [i, range] of ranges.entries()) {
    writer.put(ID, batch(data[i] ?? []), { range });
  }
  const first = ranges[0] as Range;
  const last = ranges.at(-1) as Range;
  const all = span(first.start, last.end);
  const snapshot = writer.snapshot(ID, all);
  if (expectedSegments !== undefined)
    expect(snapshot.segments).toHaveLength(expectedSegments);
  await source.flush();
  const records = source.records();

  const receiverSpy = probe(offset);
  const reader = engine(daily, {}, receiverSpy.context);
  expect(hydrate(reader, snapshot)).toEqual({ applied: snapshot.coverage });
  expect(receiverSpy.lookups.length).toBeLessThanOrEqual(charge(snapshot));
  expect(receiverSpy.context.tableCount).toBe(0);

  receiverSpy.lookups.length = 0;
  expect(reader.snapshot(ID, all)).toEqual(snapshot);
  expect(receiverSpy.lookups.length).toBeLessThanOrEqual(charge(snapshot));
  expect(receiverSpy.context.tableCount).toBe(0);

  const loaderSpy = probe(offset);
  const loaded = engine(daily, { persist: true }, loaderSpy.context);
  await persisted(loaded, records);
  const loadCharge = records.pages.reduce(
    (sum, page) => sum + charge(page.snapshot),
    0,
  );
  expect(loaderSpy.lookups.length).toBeLessThanOrEqual(loadCharge);
  expect(loaderSpy.context.tableCount).toBe(0);
  expect(loaded.get(ID, all)).toEqual(writer.get(ID, all));
}

it("17: a full cold daily page with one payload costs at most 72 calls per record operation", async () => {
  const timestamps = points(0, 32_768);
  await checkRecordCost([hull(timestamps)], [timestamps], winter, 1);
});

it("17: record work for one bar in each of 100 cold blocks follows the anchors", async () => {
  const timestamps = Array.from({ length: 100 }, (_, i) =>
    dailyStart(i * cap + 20),
  );
  await checkRecordCost([hull(timestamps)], [timestamps], winter, 100);
});

it("17: seeded calendar records of different shapes stay within the lookup charge", async () => {
  const random = rng(129_017);
  for (let run = 0; run < 8; run++) {
    const offset = random.pick([-5, -3.5, 5.75, 10.5]) * HOUR;
    const at = (slot: number) => slot * DAY + 9.5 * HOUR - offset;
    const initial = random.int(1000, 30_000);
    const data = [];
    const ranges = [];
    for (let n = 0; n < 5; n++) {
      const slot = initial + n * 80;
      const length = random.int(1, 40);
      ranges.push(span(at(slot), at(slot + length - 1)));
      data.push(
        slots(slot, slot + length - 1)
          .filter(() => random.int(0, 3) !== 0)
          .map(at),
      );
    }
    await checkRecordCost(ranges, data, () => offset);
  }
});

it("17: hydrate adds at most 12 calls per covered island in the receiving range", () => {
  const timestamps = points(block + 20, 100);
  const writer = engine(daily, {}, probe(winter).context);
  writer.put(ID, batch(timestamps));
  const snapshot = writer.snapshot(ID, hull(timestamps));
  const { context, lookups } = probe(winter);
  const receiver = engine(daily, {}, context);
  const existing = timestamps.filter((_, i) => i % 2 === 0);
  for (const t of existing) receiver.put(ID, batch([t], [-1]));
  lookups.length = 0;
  expect(hydrate(receiver, snapshot)).toEqual({
    applied: timestamps.filter((_, i) => i % 2 === 1).map((t) => span(t)),
  });
  expect(lookups.length).toBeLessThanOrEqual(
    charge(snapshot) + 12 * existing.length,
  );
  expect(context.tableCount).toBe(0);
  expect(receiver.get(ID, hull(timestamps)).fields.value).toEqual(
    new Float64Array(timestamps.map((t, i) => (i % 2 === 0 ? -1 : t))),
  );
});

it("17: hydrate accepts an exact charge, refuses one over before lookup, and snapshot has no budget", () => {
  const t = dailyStart(block + 20);
  const range = span(t);
  const writer = engine(daily, {}, probe(winter, { lookupBudget: 1 }).context);
  writer.put(ID, batch([t]));
  const snapshot = writer.snapshot(ID, range);
  expect(charge(snapshot)).toBe(72);
  const exact = probe(winter, { lookupBudget: 72 });
  expect(hydrate(engine(daily, {}, exact.context), snapshot)).toEqual({
    applied: [range],
  });

  const over = probe(winter, { lookupBudget: 71 });
  const receiver = engine(daily, {}, over.context);
  const calendar = format2(snapshot);
  const payload = calendar.segments[0];
  for (const value of [
    calendar,
    { ...calendar, range: span(t + 1), rangeSlots: ["bad", 9] },
    { ...calendar, coverage: [span(t + 1)], coverageSlots: ["bad"] },
    { ...calendar, segments: [{ ...payload, start: t + 1, startSlot: "bad" }] },
    {
      ...calendar,
      range: span(t + 1),
      coverage: [span(t + 1)],
      segments: [{ ...payload, start: t + 1 }],
    },
  ]) {
    expectTscacheError(() => hydrate(receiver, value));
    expect(over.lookups).toEqual([]);
  }
  expect(receiver.get(ID, range)).toMatchObject({
    coverage: [],
    misses: [miss(range)],
  });
});

it("17: the default budget accepts the nearest attainable charge below 524,288 and rejects the next one", () => {
  const begin = block + 20;
  const coverageSlots = Array.from(
    { length: 14_562 },
    (_, i): [number, number] => {
      const slot = begin + 2 * i;
      return [slot, slot];
    },
  );
  const end = begin + 2 * (coverageSlots.length - 1);
  const writer = engine(daily, {}, probe(winter).context);
  writer.put(ID, batch([dailyStart(begin), dailyStart(begin + 2)]));
  const template = format2(
    writer.snapshot(ID, span(dailyStart(begin), dailyStart(begin + 2))),
  );
  // Start from a real one-point payload so adding a payload adds exactly 12.
  const point = format2(writer.snapshot(ID, span(dailyStart(begin))))
    .segments[0];
  if (point === undefined) throw new Error("missing one-point payload");
  const nearest: CalendarSnapshot = {
    ...template,
    range: span(dailyStart(begin), dailyStart(end)),
    rangeSlots: [begin, end],
    coverage: coverageSlots.map(([slot]) => span(dailyStart(slot))),
    coverageSlots,
    segments: [point],
    finalizedUntil: dailyStart(end + 1),
  };
  const over = {
    ...nearest,
    segments: [
      point,
      { ...point, start: dailyStart(begin + 2), startSlot: begin + 2 },
    ],
  };
  expect(charge(nearest as unknown as Snapshot)).toBe(524_280);
  expect(charge(over as unknown as Snapshot)).toBe(524_292);
  const refused = probe(winter);
  expectTscacheError(() => hydrate(engine(daily, {}, refused.context), over));
  expect(refused.lookups).toEqual([]);

  const accepted = probe(winter);
  expect(hydrate(engine(daily, {}, accepted.context), nearest).applied).toEqual(
    nearest.coverage,
  );
  expect(accepted.lookups.length).toBeLessThanOrEqual(524_280);
});

it.each([
  { budget: 156, kept: 2 },
  { budget: 155, kept: 1 },
])(
  "17: a load with budget $budget keeps $kept newest pages and does no offset work for skipped pages",
  async ({ budget, kept }) => {
    const options = { persist: true, segmentSlotCap: 16 };
    const timestamps = [
      dailyStart(block + 5),
      dailyStart(block + 21),
      dailyStart(block + 37),
    ];
    const watermark = dailyStart(block + 50);
    const writer = engine(daily, options, probe(winter).context);
    const source = await persisted(writer);
    writer.setFinalizedUntil(ID, watermark);
    for (const t of timestamps) writer.put(ID, batch([t]));
    await source.flush();
    const records = source.records();
    expect(requireCache(records).finalizedUntil).toBe(watermark);
    expect(records.pages.map(({ snapshot }) => charge(snapshot))).toEqual([
      72, 72, 72,
    ]);

    const { context, lookups } = probe(winter, { lookupBudget: budget });
    const reader = engine(daily, options, context);
    const store = new MemoryStore();
    store.seed(ID, records);
    const gate = store.gate("read");
    const persister = new Persister(reader, async () => store);
    const opened = persister.open(ID);
    await gate.entered;
    // Reading (i) leaves the full lookup budget after the store read settles.
    await tick(4_999);
    gate.release();
    await opened;
    const skipped = timestamps.slice(0, -kept);
    expect(lookups.length).toBeGreaterThan(0);
    for (const instant of skipped) {
      expect(
        lookups.some((lookup) => Math.abs(lookup - instant) <= 3 * DAY),
      ).toBe(false);
    }
    expect(lookups.length).toBeLessThanOrEqual(12 + 72 * kept);
    const newest = timestamps.slice(-kept);
    expect(reader.get(ID, hull(timestamps))).toMatchObject({
      timestamps: new Float64Array(newest),
      coverage: newest.map((t) => span(t)),
    });
    expect(context.tableCount).toBe(0);
    await finish(persister.flush(ID));
    expect(store.records(ID).pages).toEqual(records.pages.slice(-kept));
  },
);
