import { afterEach, expect, it, vi } from "vitest";
import { Engine } from "../src/engine/engine";
import { ConfigError, InvalidRangeError, PutError } from "../src/errors";
import { snapOut, toMs } from "../src/grid";
import {
  APIA,
  addCache,
  batch,
  type CalendarDescriptor,
  calendarGrid,
  DAY,
  daySlot,
  engine,
  expectTscacheError,
  format2,
  hydrate,
  ID,
  miss,
  NY,
  nyOffset,
  persisted,
  probe,
  span,
  startOf,
  utc,
  withFetcher,
} from "./calendar-contract-helpers";
import { fakeTime } from "./persist-harness";
import { requireCache } from "./persist-test-helpers";

const daily = { unit: "day", zone: NY, at: "09:30" } as const;
const march6 = utc("2026-03-06T14:30Z");
const march7 = utc("2026-03-07T14:30Z");
const march8 = utc("2026-03-08T13:30Z");
const march9 = utc("2026-03-09T13:30Z");
const march10 = utc("2026-03-10T13:30Z");

fakeTime();
afterEach(() => vi.unstubAllGlobals());

it.each([
  { zone: APIA, next: "2011-12-30T10:00Z" },
  { zone: "Pacific/Kwajalein", next: "1993-08-21T12:00Z" },
])(
  "4: a fetch covers $zone's skipped slot as a gap and the next bar stays on its day",
  async ({ zone, next }) => {
    const e = engine({ unit: "day", zone });
    const nextStart = utc(next);
    const skipped = span(nextStart - 1);
    const { orchestrator, requests } = await withFetcher(e, () => batch([]));
    expect(await orchestrator.get(ID, skipped)).toMatchObject({
      timestamps: new Float64Array(),
      coverage: [skipped],
      misses: [],
    });
    expect(requests.map(({ range }) => range)).toEqual([skipped]);
    await orchestrator.get(ID, skipped);
    expect(requests).toHaveLength(1);
    e.put(ID, batch([nextStart], [7]));
    expect(e.get(ID, span(skipped.start, nextStart))).toMatchObject({
      timestamps: new Float64Array([nextStart]),
      fields: { value: new Float64Array([7]) },
      coverage: [span(skipped.start, nextStart)],
    });
    expect(format2(e.snapshot(ID, skipped)).segments).toEqual([]);
  },
);

const badOuter = [
  { name: "just beyond Date", timestamp: 8_640_000_000_000_001 },
  { name: "9e15", timestamp: 9_000_000_000_000_000 },
  { name: "before outer bound", timestamp: utc("0001-01-01T09:30Z") - DAY - 1 },
  {
    name: "after outer bound",
    timestamp: utc("+010000-01-01T09:30Z") + DAY + 1,
  },
];
const badInner = [
  {
    name: "the first start outside the domain",
    timestamp: utc("+010000-01-01T14:30Z"),
  },
  {
    name: "inside the last outer margin",
    timestamp: utc("+010000-01-02T00:00Z"),
  },
];

it.each([...badOuter, ...badInner])(
  "5: domain guard on engine calls and stored watermarks at $name",
  async ({ timestamp }) => {
    const { context } = probe(nyOffset);
    const e = engine(daily, { persist: true }, context);
    const store = await persisted(e);
    e.put(ID, batch([march6], [1]));
    const request = span(
      Math.min(march6, timestamp),
      Math.max(march6, timestamp),
    );
    const before = e.snapshot(ID, span(march6));
    const write = () => e.put(ID, batch([timestamp]));
    expect(write).toThrow(PutError);
    expect(write).toThrow(
      expect.objectContaining({
        code: "misaligned",
        offenderIndex: 0,
        offenderTimestamp: timestamp,
      }),
    );
    expect(() => e.get(ID, request)).toThrow(InvalidRangeError);
    expect(() => e.coverage(ID, request)).toThrow(InvalidRangeError);
    expect(() => e.invalidate(ID, request)).toThrow(InvalidRangeError);
    expect(() => e.setFinalizedUntil(ID, timestamp)).toThrow(InvalidRangeError);
    expectTscacheError(
      () => hydrate(e, { ...before, finalizedUntil: timestamp }),
      /finalizedUntil/,
    );
    expect(e.snapshot(ID, span(march6))).toEqual(before);

    await store.flush();
    const stored = store.records();
    const target = engine(daily, { persist: true }, probe(nyOffset).context);
    const loading = await persisted(target, {
      ...stored,
      cache: { ...requireCache(stored), finalizedUntil: timestamp },
    });
    expect(target.snapshot(ID, span(march6))).not.toHaveProperty(
      "finalizedUntil",
    );
    await loading.flush();
    expect(loading.records().cache?.finalizedUntil).toBeUndefined();
    expect(
      loading.store.log.some((call) => call.kind === "write" && call.settled),
    ).toBe(true);
  },
);

it("5b: get accepts the last day start and rejects ends that would ceil beyond it", () => {
  const { context } = probe(nyOffset);
  const e = engine(daily, {}, context);
  const last = utc("9999-12-31T14:30Z");
  const first = utc("0001-01-01T14:30Z");
  expect(e.get(ID, span(last)).misses).toEqual([miss(span(last))]);
  expect(e.get(ID, span(first)).misses).toEqual([miss(span(first))]);
  expect(() => e.get(ID, span(first - 1, first))).toThrow(InvalidRangeError);
  for (const t of [
    utc("+010000-01-01T14:30Z") - 1,
    utc("+010000-01-01T00:00Z"),
  ]) {
    expect(() => e.get(ID, span(last, t))).toThrow(InvalidRangeError);
    expect(() => e.invalidate(ID, span(last, t))).toThrow(InvalidRangeError);
    expect(() => e.setFinalizedUntil(ID, t)).toThrow(InvalidRangeError);
  }
});

it.each([
  {
    interval: { unit: "week", weekStart: 5 },
    start: "9999-12-31T00:00Z",
    inside: "+010000-01-05T00:00Z",
  },
  {
    interval: { unit: "week", zone: NY },
    start: "9999-12-27T05:00Z",
    inside: "+010000-01-03T04:00Z",
  },
] as const)(
  "5b: get cannot ceil beyond the last week starting at $start",
  ({ interval, start, inside }) => {
    const e = engine(interval, {}, probe(nyOffset).context);
    expect(e.get(ID, span(utc(start))).misses).toEqual([
      miss(span(utc(start))),
    ]);
    expect(() => e.get(ID, span(utc(start), utc(inside)))).toThrow(
      InvalidRangeError,
    );
  },
);

it("7: a mid-month watermark leaves that month's start covered and makes the next month's start volatile", () => {
  const e = engine({ unit: "month" });
  const feb = utc("2024-02-01");
  const mar = utc("2024-03-01");
  const apr = utc("2024-04-01");
  e.setFinalizedUntil(ID, utc("2024-02-15"));
  e.put(ID, batch([feb, mar, apr]));
  expect(e.get(ID, span(feb, apr))).toMatchObject({
    timestamps: new Float64Array([feb, mar, apr]),
    coverage: [span(feb)],
    misses: [miss(span(mar, apr))],
  });
});

it.each([
  { field: "unit", interval: { unit: "hour" } },
  { field: "unit", interval: {} },
  { field: "zone", interval: { unit: "day", zone: "No/Such_Zone" } },
  { field: "zone", interval: { unit: "day", zone: 0 } },
  { field: "zone", interval: { unit: "day", zone: "" } },
  { field: "at", interval: { unit: "day", at: "9:30" } },
  { field: "at", interval: { unit: "day", at: "24:00" } },
  { field: "at", interval: { unit: "day", at: "09:60" } },
  { field: "at", interval: { unit: "day", at: "09:30:00" } },
  { field: "at", interval: { unit: "day", at: 930 } },
  { field: "weekStart", interval: { unit: "day", weekStart: 1 } },
  { field: "weekStart", interval: { unit: "week", weekStart: 0 } },
  { field: "weekStart", interval: { unit: "week", weekStart: 8 } },
  { field: "weekStart", interval: { unit: "week", weekStart: 1.5 } },
  { field: "weekStart", interval: { unit: "week", weekStart: "1" } },
  {
    field: "alignmentOffset",
    interval: { unit: "day" },
    options: { alignmentOffset: 1 },
  },
  {
    field: "alignmentOffset",
    interval: { unit: "day" },
    options: { alignmentOffset: -1 },
  },
])(
  "9: ConfigError names invalid $field in $interval",
  ({ field, interval, options }) => {
    const e = new Engine();
    const create = () => addCache(e, interval as CalendarDescriptor, options);
    expect(create).toThrow(ConfigError);
    expect(create).toThrow(new RegExp(`^(?:(?!\\bgot\\b).)*\\b${field}\\b`));
    expect(e.has(ID)).toBe(false);
  },
);

it("9: the frozen descriptor applies defaults, joins by value and ignores later mutation of input", () => {
  const e = new Engine();
  const raw: CalendarDescriptor = { unit: "week" };
  const resolved = addCache(e, raw);
  expect(resolved.interval).toEqual({
    unit: "week",
    zone: "UTC",
    at: "00:00",
    weekStart: 1,
  });
  expect(Object.isFrozen(resolved.interval)).toBe(true);
  expect(resolved.alignmentOffset).toBe(0);
  raw.weekStart = 7;
  expect(
    addCache(
      e,
      { unit: "week", zone: "UTC", at: "00:00", weekStart: 1 },
      { alignmentOffset: 0 },
    ),
  ).toBe(resolved);

  const day = addCache(e, { unit: "day", at: "23:59" }, { id: "day" });
  expect(day.interval).toEqual({ unit: "day", zone: "UTC", at: "23:59" });
  expect(Object.isFrozen(day.interval)).toBe(true);
  const t = utc("2026-03-08T23:59Z");
  e.put("day", batch([t]));
  expect(e.get("day", span(t)).timestamps).toEqual(new Float64Array([t]));
});

it.each([
  { field: "unit", different: { unit: "month", zone: NY, at: "09:30" } },
  {
    field: "zone",
    different: { unit: "week", zone: "Europe/London", at: "09:30" },
  },
  {
    field: "zone alias",
    different: { unit: "week", zone: "US/Eastern", at: "09:30" },
  },
  { field: "at", different: { unit: "week", zone: NY, at: "09:31" } },
  {
    field: "weekStart",
    different: { unit: "week", zone: NY, at: "09:30", weekStart: 7 },
  },
  { field: "fixed interval", different: 7 * DAY },
] as const)(
  "9: a different $field conflicts with a live config",
  ({ different }) => {
    const e = engine({ unit: "week", zone: NY, at: "09:30" });
    expect(() => addCache(e, different)).toThrow(ConfigError);
    expect(() => addCache(e, different)).toThrow(/interval/);
  },
);

it("10: a misaligned calendar point reports its first index and value and writes nothing", () => {
  const e = engine(daily);
  e.put(ID, { ...batch([march6], [1]), meta: { version: "original" } });
  const before = e.snapshot(ID, span(march6, march10));
  const wrong = utc("2026-03-09T14:30Z");
  const put = () =>
    e.put(ID, {
      ...batch([march8, wrong, march10]),
      meta: { version: "wrong" },
    });
  expect(put).toThrow(PutError);
  expect(put).toThrow(
    expect.objectContaining({
      code: "misaligned",
      offenderIndex: 1,
      offenderTimestamp: wrong,
      message: expect.stringMatching(/day.*America\/New_York.*09:30/),
    }),
  );
  expect(e.snapshot(ID, span(march6, march10))).toEqual(before);
  e.put(ID, batch([march8, march9, march10], [8, 9, 10]));
  expect(e.get(ID, span(march6, march10))).toMatchObject({
    timestamps: new Float64Array([march6, march8, march9, march10]),
    fields: { value: new Float64Array([1, 8, 9, 10]) },
  });
});

it("11: reads return slot starts and outward calendar ranges in milliseconds", () => {
  const e = engine(daily);
  e.put(ID, batch([march8, march9], [8, 9]), {
    range: span(march7 + 1, march10 - 1),
  });
  const request = span(march7 + 1, march9 + 1);
  const grid = calendarGrid(daily);
  expect(toMs(snapOut(request, grid), grid)).toEqual(span(march7, march10));
  expect(e.get(ID, request)).toEqual({
    timestamps: new Float64Array([march8, march9]),
    fields: { value: new Float64Array([8, 9]) },
    coverage: [span(march8, march9)],
    misses: [miss(span(march7)), miss(span(march10))],
  });
});

it.each([
  { empty: 2, second: "2026-03-09T13:30Z", counts: [4] },
  { empty: 4, second: "2026-03-11T13:30Z", counts: [6] },
  { empty: 5, second: "2026-03-12T13:30Z", counts: [1, 1] },
])(
  "12: $empty empty days have the specified segment split and stay covered",
  ({ second, counts }) => {
    const e = engine(daily);
    const end = utc(second);
    const range = span(march6, end);
    e.put(ID, batch([march6, end]), { range });
    expect(e.snapshot(ID, range).segments.map(({ count }) => count)).toEqual(
      counts,
    );
    expect(e.get(ID, range)).toMatchObject({ coverage: [range], misses: [] });
  },
);

it("12: page boundaries are multiples of the calendar slot cap across DST", async () => {
  const e = engine(daily, { persist: true, segmentSlotCap: 2 });
  const h = await persisted(e);
  const march5 = utc("2026-03-05T14:30Z");
  e.put(ID, batch([march5, march6, march7, march8, march9]));
  await h.flush();
  const starts = [march5, march6, march8];
  const anchorSlots = ["2026-03-05", "2026-03-06", "2026-03-08"].map(daySlot);
  const records = h.records().pages;
  expect(records.map(({ page }) => page)).toEqual(
    anchorSlots.map((slot) => Math.floor(slot / 2)),
  );
  expect(records.map(({ snapshot }) => snapshot.range)).toEqual([
    span(march5),
    span(march6, march7),
    span(march8, march9),
  ]);
  expect(
    records.map(({ snapshot }) =>
      snapshot.segments.map(({ start, count }) => [start, count]),
    ),
  ).toEqual([[[starts[0], 1]], [[starts[1], 2]], [[starts[2], 2]]]);
});

it("16: a monthly fetch carries its descriptor and coalesces only the covered flank", async () => {
  const descriptor = { unit: "month", zone: NY, at: "09:30" } as const;
  const e = engine(descriptor);
  const feb = utc("2026-02-01T14:30Z");
  const mar = utc("2026-03-01T14:30Z");
  const apr = utc("2026-04-01T13:30Z");
  const may = utc("2026-05-01T13:30Z");
  e.put(ID, batch([feb, mar]));
  const { orchestrator, requests } = await withFetcher(e, () =>
    batch([mar, apr, may]),
  );
  const read = await orchestrator.get(ID, span(mar + 1, may));
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    range: span(mar, may),
    interval: descriptor,
    alignmentOffset: 0,
  });
  expect(read).toMatchObject({
    timestamps: new Float64Array([mar, apr, may]),
    coverage: [span(mar, may)],
    misses: [],
  });
});

it("8: the cold yearly fetch fills the truncated edge block while an empty read leaves it cold", async () => {
  const yearly = { unit: "year", zone: NY } as const;
  const { context, lookups } = probe(nyOffset);
  const e = engine(yearly, {}, context);
  const years = Array.from({ length: 200 }, (_, index) =>
    utc(`${9800 + index}-01-01T05:00Z`),
  );
  const range = span(utc("9800-01-01T05:00Z"), utc("9999-01-01T05:00Z"));
  expect(e.get(ID, range).misses).toEqual([miss(range)]);
  expect(context.tableCount).toBe(0);

  const { orchestrator } = await withFetcher(e, () => batch(years));
  lookups.length = 0;
  expect(await orchestrator.get(ID, range)).toMatchObject({
    timestamps: new Float64Array(years),
    coverage: [range],
    misses: [],
  });
  expect(context.tableCount).toBe(1);
  const g6Last = utc("+010002-01-01");
  expect(lookups.some((instant) => Math.abs(instant - g6Last) <= DAY)).toBe(
    true,
  );
  expect(Math.max(...lookups)).toBeLessThanOrEqual(g6Last + DAY);
  expect(startOf(8032 - 1, calendarGrid(yearly, context))).toBe(
    utc("+010001-01-01T05:00Z"),
  );
});
