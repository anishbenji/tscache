import { expect, it } from "vitest";
import { cacheStateOf } from "../src/engine/engine";
import { cacheRecordOf, pageRecordsOf } from "../src/persist/records";
import type { StoredCache } from "../src/persist/store";
import { decodeSnapshot, encodeSnapshot } from "../src/snapshot";
import type {
  CalendarSnapshot,
  EncodedSnapshot,
  Range,
  Snapshot,
} from "../src/types";
import {
  APIA,
  apiaOffset,
  batch,
  type CalendarDescriptor,
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
  slots,
  span,
  utc,
} from "./calendar-contract-helpers";
import { fakeTime } from "./persist-harness";
import { requireCache, requirePage } from "./persist-test-helpers";

fakeTime();

const fixedOptions = { alignmentOffset: 3, persist: true };
const fixedRange = span(3, 23);

// Format 1 as in v0.1.0: a dense three-slot payload with an empty middle slot.
const fixedGolden = {
  format: 1,
  interval: 10,
  alignmentOffset: 3,
  fields: { value: "f64" },
  range: fixedRange,
  coverage: [fixedRange],
  segments: [
    {
      format: 1,
      layout: "dense",
      start: 3,
      count: 3,
      interval: 10,
      alignmentOffset: 3,
      mask: new Uint8Array([0x05]),
      fields: [
        {
          name: "value",
          dtype: "f64",
          data: new Float64Array([1, 0, Number.NaN]).buffer,
        },
      ],
    },
  ],
};

it("1: the fixed grid still writes the 0.1.0 payload, snapshot and stored records", async () => {
  const e = engine(10, fixedOptions);
  const h = await persisted(e);
  e.put(ID, batch([3, 23], [1, Number.NaN]));
  expect(e.snapshot(ID, fixedRange)).toEqual(fixedGolden);
  await h.flush();
  expect(h.records()).toEqual({
    cache: {
      cacheId: ID,
      format: 1,
      config: {
        interval: 10,
        alignmentOffset: 3,
        fields: { value: "f64" },
        gapSplitK: 4,
        segmentSlotCap: 32_768,
        warnOnOverlapDiff: false,
      },
    },
    pages: [{ cacheId: ID, page: 0, snapshot: fixedGolden }],
  });
});

const daily = { unit: "day", zone: NY, at: "09:30" } as const;
const apia = { unit: "day", zone: APIA } as const;
const march5 = utc("2026-03-05T14:30Z");
const march6 = utc("2026-03-06T14:30Z");
const march7 = utc("2026-03-07T14:30Z");
const march9 = utc("2026-03-09T13:30Z");
const dailyRange = span(march5, march9);

it("13: format 2 carries the descriptor and all anchor indices and hydrates only a matching calendar", () => {
  const writer = engine(daily);
  writer.put(ID, batch([march5, march6], [17, 18]), { range: dailyRange });
  const snapshot = format2(writer.snapshot(ID, dailyRange));
  expect(snapshot).toMatchObject({
    format: 2,
    grid: daily,
    rangeSlots: [20_517, 20_521],
    coverageSlots: [[20_517, 20_521]],
    segments: [{ format: 2, grid: daily, startSlot: 20_517 }],
  });
  for (const object of [snapshot, ...snapshot.segments]) {
    expect(object).not.toHaveProperty("interval");
    expect(object).not.toHaveProperty("alignmentOffset");
  }
  const reader = engine({ ...daily });
  expect(hydrate(reader, snapshot)).toEqual({ applied: [dailyRange] });
  expect(reader.get(ID, dailyRange)).toEqual(writer.get(ID, dailyRange));
  expect(reader.snapshot(ID, dailyRange)).toEqual(snapshot);
  const fixed = engine(DAY);
  expectTscacheError(() => hydrate(fixed, snapshot));
  expectTscacheError(() => hydrate(reader, fixedGolden));
  expectTscacheError(() =>
    hydrate(engine({ ...daily, at: "09:31" }), snapshot),
  );
  expectTscacheError(() =>
    hydrate(engine({ ...daily, zone: "US/Eastern" }), snapshot),
  );
});

const apiaJump = utc("2011-12-30T10:00Z");
const earlyApiaJump = utc("2011-12-29T10:00Z");
const normalApiaOffset = apiaOffset(apiaJump);
const earlyApiaOffset = apiaOffset(earlyApiaJump);
const minusTen = () => -10 * HOUR;
const minusEleven = () => -11 * HOUR;
const atTen = (slot: number) => slot * DAY + 10 * HOUR;
const atEleven = (slot: number) => slot * DAY + 11 * HOUR;
const apiaStart = (skip: number) => (slot: number) => {
  if (slot < skip) return atTen(slot);
  if (slot === skip) return atTen(slot) - 1;
  return atTen(slot - 1);
};
const normalApiaStart = apiaStart(15_338);
const earlyApiaStart = apiaStart(15_337);
const nyStart =
  (firstSummer: number, endSummer = daySlot("2026-11-01")) =>
  (slot: number): number =>
    slot * DAY + (slot >= firstSummer && slot < endSummer ? 13.5 : 14.5) * HOUR;
const normalNyStart = nyStart(20_520);
const noSummer = Number.POSITIVE_INFINITY;
const whole = slots(15_309, 15_344);

interface ZoneCase {
  name: string;
  writerOffset: (instant: number) => number;
  readerOffset: (instant: number) => number;
  writerStart: (slot: number) => number;
  readerStart: (slot: number) => number;
  descriptor?: CalendarDescriptor;
  rangeSlots?: number[];
  pointSlots?: number[];
  refused?: boolean;
  cap?: number;
  watermark?: number;
}

const repeatOffset = (switchAt: number) => (t: number) =>
  t < switchAt ? 14 * HOUR : -10 * HOUR;
const repeatStart = (firstAfter: number) => (slot: number) =>
  slot < firstAfter ? atTen(slot - 1) : atTen(slot);

const zoneCases: ZoneCase[] = [
  {
    name: "a: identical rules preserve a covered skipped date",
    writerOffset: normalApiaOffset,
    readerOffset: normalApiaOffset,
    writerStart: normalApiaStart,
    readerStart: normalApiaStart,
    pointSlots: whole.filter((slot) => slot !== 15_338),
  },
  {
    name: "b: a change after the record preserves every read value",
    writerOffset: minusTen,
    readerOffset: apiaOffset(utc("2012-01-07T10:00Z")),
    writerStart: atTen,
    readerStart: atTen,
  },
  {
    name: "c: a different offset throughout refuses the record",
    writerOffset: minusTen,
    readerOffset: minusEleven,
    writerStart: atTen,
    readerStart: atEleven,
    refused: true,
  },
  {
    name: "d: a shifted DST date moves seven interior timestamps",
    descriptor: daily,
    writerOffset: nyOffset,
    readerOffset: (instant) => nyOffset(instant, utc("2026-03-15T07:00Z")),
    writerStart: normalNyStart,
    readerStart: nyStart(20_527),
    rangeSlots: slots(daySlot("2026-02-01"), daySlot("2026-04-30")),
  },
  {
    name: "e: a skip before the sole anchor refuses the record",
    writerOffset: minusTen,
    readerOffset: normalApiaOffset,
    writerStart: atTen,
    readerStart: normalApiaStart,
    rangeSlots: [15_339],
    refused: true,
  },
  {
    name: "f: an interior skip that shifts an end anchor refuses the record",
    writerOffset: minusTen,
    readerOffset: normalApiaOffset,
    writerStart: atTen,
    readerStart: normalApiaStart,
    refused: true,
  },
  {
    name: "g: differently dated skips retain the writer's point indices",
    writerOffset: earlyApiaOffset,
    readerOffset: normalApiaOffset,
    writerStart: earlyApiaStart,
    readerStart: normalApiaStart,
    pointSlots: whole.filter((slot) => slot !== 15_337),
  },
  {
    name: "h: a writer-only skip and repeat move five bars within the record",
    writerOffset: (instant) =>
      instant >= utc("2011-12-15T10:00Z") && instant < utc("2011-12-20T10:00Z")
        ? 14 * HOUR
        : -10 * HOUR,
    readerOffset: minusTen,
    writerStart: (slot) =>
      slot >= 15_324 && slot <= 15_328 ? atTen(slot - 1) : atTen(slot),
    readerStart: atTen,
    pointSlots: whole.filter((slot) => slot !== 15_323),
  },
  {
    name: "i: a differently dated repeat moves one interior bar a day early",
    writerOffset: repeatOffset(utc("2011-12-14T10:00Z")),
    readerOffset: repeatOffset(utc("2011-12-15T10:00Z")),
    writerStart: repeatStart(15_323),
    readerStart: repeatStart(15_324),
  },
  {
    name: "k: a watermark can name a different first volatile slot",
    writerOffset: minusTen,
    readerOffset: apiaOffset(utc("2012-01-06T10:00Z")),
    writerStart: atTen,
    readerStart: apiaStart(daySlot("2012-01-06")),
    watermark: utc("2012-01-08T10:00Z"),
  },
  {
    name: "l: all four pages survive with the differently dated skips",
    writerOffset: earlyApiaOffset,
    readerOffset: normalApiaOffset,
    writerStart: earlyApiaStart,
    readerStart: normalApiaStart,
    cap: 16,
    pointSlots: whole.filter((slot) => slot !== 15_337),
  },
  {
    name: "m: different starts strictly inside a confirmed gap are allowed",
    writerOffset: (instant) =>
      instant >= utc("2011-12-15T10:00Z") && instant < utc("2011-12-20T10:00Z")
        ? -9 * HOUR
        : -10 * HOUR,
    readerOffset: minusTen,
    writerStart: atTen,
    readerStart: atTen,
    pointSlots: [...slots(15_309, 15_313), ...slots(15_340, 15_344)],
  },
  {
    name: "n: an entire differing DST season with winter anchors is allowed",
    descriptor: daily,
    writerOffset: nyOffset,
    readerOffset: () => -5 * HOUR,
    writerStart: normalNyStart,
    readerStart: nyStart(noSummer),
    rangeSlots: slots(daySlot("2026-01-05"), daySlot("2026-12-18")),
  },
];

function endpoints(
  numbers: number[],
  convert: (slot: number) => number,
): Range {
  return span(convert(numbers[0] as number), convert(numbers.at(-1) as number));
}

const charge = (
  snapshot: Pick<Snapshot, "segments" | "coverage" | "finalizedUntil">,
): number =>
  24 +
  12 * snapshot.segments.length +
  36 * snapshot.coverage.length +
  (snapshot.finalizedUntil === undefined ? 0 : 12);

function loadCharge(records: StoredCache): number {
  return records.pages.reduce(
    (total, page) => total + charge(page.snapshot),
    records.cache?.finalizedUntil === undefined ? 0 : 12,
  );
}

async function produce(tc: ZoneCase) {
  const descriptor = tc.descriptor ?? apia;
  const rangeSlots = tc.rangeSlots ?? whole;
  const points = tc.pointSlots ?? rangeSlots;
  const range = endpoints(rangeSlots, tc.writerStart);
  const options = {
    persist: true,
    ...(tc.cap === undefined ? {} : { segmentSlotCap: tc.cap }),
  };
  const { context, lookups } = probe(tc.writerOffset);
  const writer = engine(descriptor, options, context);
  const disk = await persisted(writer);
  if (tc.watermark !== undefined) writer.setFinalizedUntil(ID, tc.watermark);
  writer.put(ID, batch(points.map(tc.writerStart), points), { range });
  lookups.length = 0;
  const warmTables = context.tableCount;
  const snapshot = writer.snapshot(ID, range);
  expect(lookups.length).toBeLessThanOrEqual(charge(snapshot));
  expect(context.tableCount).toBe(warmTables);
  await disk.flush();
  return {
    descriptor,
    range,
    points,
    options,
    writer,
    snapshot,
    records: disk.records(),
  };
}

function expectApplied(
  reader: ReturnType<typeof engine>,
  tc: ZoneCase,
  range: Range,
  points: number[],
) {
  expect(reader.get(ID, range)).toEqual({
    timestamps: new Float64Array(points.map(tc.readerStart)),
    fields: { value: new Float64Array(points) },
    coverage: [range],
    misses: [],
  });
}

function checkWatermarkPlacement(
  writer: ReturnType<typeof engine>,
  reader: ReturnType<typeof engine>,
  tc: ZoneCase,
): void {
  if (tc.watermark === undefined) return;
  const writerLastFinal = span(tc.writerStart(15_346));
  const readerLastFinal = span(tc.readerStart(15_347));
  for (const [cache, range] of [
    [writer, writerLastFinal],
    [reader, readerLastFinal],
  ] as const) {
    cache.put(ID, batch([range.start, tc.watermark]));
    expect(cache.coverage(ID, span(range.start, tc.watermark))).toEqual([
      range,
    ]);
    expect(cache.get(ID, span(tc.watermark)).misses).toEqual([
      miss(span(tc.watermark)),
    ]);
  }
}

it.each(zoneCases)("13/17: hydrate $name", async (tc) => {
  const { descriptor, range, points, options, writer, snapshot } =
    await produce(tc);
  const { context, lookups } = probe(tc.readerOffset);
  const reader = engine(descriptor, options, context);
  if (tc.refused === true) {
    const targetRange = endpoints(tc.rangeSlots ?? whole, tc.readerStart);
    const before = reader.snapshot(ID, targetRange);
    lookups.length = 0;
    expectTscacheError(() => hydrate(reader, snapshot));
    expect(lookups.length).toBeLessThanOrEqual(charge(snapshot));
    expect(reader.snapshot(ID, targetRange)).toEqual(before);
    expect(context.tableCount).toBe(0);
  } else {
    expect(hydrate(reader, snapshot)).toEqual({ applied: [range] });
    expect(lookups.length).toBeLessThanOrEqual(charge(snapshot));
    expect(context.tableCount).toBe(0);
    expectApplied(reader, tc, range, points);
    expect(reader.snapshot(ID, range)).toEqual(snapshot);
    if (tc.name.startsWith("m:")) {
      const gap = span(tc.readerStart(15_324), tc.readerStart(15_328));
      expect(reader.get(ID, gap)).toMatchObject({
        timestamps: new Float64Array(),
        coverage: [gap],
        misses: [],
      });
    }
    checkWatermarkPlacement(writer, reader, tc);
  }
});

it.each(zoneCases)("13/17: load $name", async (tc) => {
  const { descriptor, range, points, options, writer, records } =
    await produce(tc);
  const { context, lookups } = probe(tc.readerOffset);
  const reader = engine(descriptor, options, context);
  const disk = await persisted(reader, records);
  expect(lookups.length).toBeLessThanOrEqual(loadCharge(records));
  expect(context.tableCount).toBe(0);
  if (tc.refused === true) {
    const targetRange = endpoints(tc.rangeSlots ?? whole, tc.readerStart);
    expect(reader.get(ID, targetRange)).toMatchObject({
      timestamps: new Float64Array(),
      coverage: [],
      misses: [miss(targetRange)],
    });
    await disk.flush();
    expect(disk.records()).toEqual({ cache: undefined, pages: [] });
  } else {
    expectApplied(reader, tc, range, points);
    if (tc.cap === 16)
      expect(records.pages.map(({ page }) => page)).toEqual([
        956, 957, 958, 959,
      ]);
    await disk.flush();
    expect(disk.records()).toEqual(records);
    checkWatermarkPlacement(writer, reader, tc);
  }
});

it.each(["hydrate", "load"] as const)(
  "13/17: %s refuses j: a changed payload anchor outside coverage",
  async (operation) => {
    const { descriptor, options, records, snapshot, range } = await produce({
      name: "j",
      writerOffset: minusTen,
      readerOffset: minusTen,
      writerStart: atTen,
      readerStart: atTen,
      pointSlots: slots(15_313, 15_340),
    });
    // Page writers omit points outside coverage. Construct the untrusted record
    // so the changed anchor can only be detected by examining its payload.
    const corrupt: CalendarSnapshot = {
      ...format2(snapshot),
      coverage: [span(atTen(15_318), atTen(15_340))],
      coverageSlots: [[15_318, 15_340]],
    };
    const { context, lookups } = probe((instant) =>
      instant >= utc("2011-12-03T10:00Z") && instant < utc("2011-12-06T10:00Z")
        ? 14 * HOUR
        : -10 * HOUR,
    );
    const reader = engine(descriptor, options, context);
    if (operation === "hydrate") {
      expectTscacheError(() => hydrate(reader, corrupt));
      expect(lookups.length).toBeLessThanOrEqual(charge(snapshot));
    } else {
      const disk = await persisted(reader, {
        cache: records.cache,
        pages: [
          { ...requirePage(records), snapshot: corrupt as unknown as Snapshot },
        ],
      });
      expect(lookups.length).toBeLessThanOrEqual(loadCharge(records));
      await disk.flush();
      expect(disk.records()).toEqual({ cache: undefined, pages: [] });
    }
    expect(reader.get(ID, range)).toMatchObject({
      timestamps: new Float64Array(),
      coverage: [],
      misses: [miss(range)],
    });
  },
);

interface Corruption {
  label: string;
  field: "rangeSlots" | "coverageSlots" | "startSlot";
  value?: unknown;
}

const holes = Array(1);
const pairHole = [1];
pairHole.length = 2;
const invalidIndexShapes: Corruption[] = [
  { label: "missing", field: "rangeSlots" },
  { label: "scalar", field: "rangeSlots", value: 1 },
  { label: "short pair", field: "rangeSlots", value: [1] },
  { label: "long pair", field: "rangeSlots", value: [1, 2, 3] },
  { label: "a hole in the pair", field: "rangeSlots", value: pairHole },
  { label: "string in the pair", field: "rangeSlots", value: [1, "2"] },
  { label: "missing", field: "coverageSlots" },
  { label: "scalar", field: "coverageSlots", value: 1 },
  { label: "a hole in the list", field: "coverageSlots", value: holes },
  { label: "short pair", field: "coverageSlots", value: [[1]] },
  { label: "long pair", field: "coverageSlots", value: [[1, 2, 3]] },
  { label: "a hole in a pair", field: "coverageSlots", value: [pairHole] },
  { label: "string in the pair", field: "coverageSlots", value: [[1, "2"]] },
  { label: "missing", field: "startSlot" },
  { label: "string", field: "startSlot", value: "1" },
];

function changeIndex<T extends { segments: readonly object[] }>(
  value: T,
  change: Corruption,
): unknown {
  const next = structuredClone(value);
  const object = (
    change.field === "startSlot" ? next.segments[0] : next
  ) as Record<string, unknown>;
  if (change.value === undefined) delete object[change.field];
  else object[change.field] = change.value;
  return next;
}

it.each([
  ...invalidIndexShapes,
  { label: "too few pairs", field: "coverageSlots", value: [] },
  {
    label: "too many pairs",
    field: "coverageSlots",
    value: [
      [20_517, 20_517],
      [20_518, 20_519],
    ],
  },
  { label: "wrong slot", field: "rangeSlots", value: [20_518, 20_517] },
  { label: "wrong slot", field: "coverageSlots", value: [[20_518, 20_517]] },
  { label: "wrong slot", field: "startSlot", value: 20_518 },
] satisfies Corruption[])(
  "13: hydrate and load refuse $label in $field",
  async (change) => {
    const writer = engine(daily, { persist: true });
    const source = await persisted(writer);
    const range = span(march5);
    writer.put(ID, { ...batch([march5], [1]), meta: { version: "source" } });
    await source.flush();
    const snapshot = format2(writer.snapshot(ID, range));
    const records = source.records();

    const target = engine(daily);
    target.put(ID, batch([march5], [2]));
    const before = target.snapshot(ID, range);
    expectTscacheError(
      () => hydrate(target, changeIndex(snapshot, change)),
      new RegExp(change.field),
    );
    expect(target.snapshot(ID, range)).toEqual(before);

    const loaded = engine(daily, { persist: true });
    const page = requirePage(records);
    const disk = await persisted(loaded, {
      cache: records.cache,
      pages: [
        { ...page, snapshot: changeIndex(page.snapshot, change) as Snapshot },
      ],
    });
    expect(loaded.get(ID, range)).toMatchObject({
      timestamps: new Float64Array(),
      coverage: [],
      misses: [miss(range)],
    });
    await disk.flush();
    expect(disk.records()).toEqual({ cache: undefined, pages: [] });
  },
);

it.each([
  { label: "identical rules", shift: undefined },
  { label: "a change to the provisional bar's slot only", shift: march6 },
  { label: "a change to an unnamed slot only", shift: march7 },
])(
  "13/14: hydrate drops the provisional tail with $label, including after JSON",
  ({ shift }) => {
    const writer = engine(
      daily,
      { finalizedUntil: march6 },
      probe(nyOffset).context,
    );
    writer.put(ID, batch([march5, march6], [Number.NaN, 6]));
    const snapshot = format2(writer.snapshot(ID, dailyRange));
    expect(snapshot.coverage).toEqual([span(march5)]);
    expect(snapshot.segments).toMatchObject([{ start: march5, count: 2 }]);
    const decoded = fromJson(snapshot as unknown as Snapshot);
    expect(decoded).toEqual(snapshot);
    const receiver = engine(
      daily,
      {},
      probe((instant) =>
        shift !== undefined &&
        instant >= shift - HOUR &&
        instant < shift + 2 * HOUR
          ? -6 * HOUR
          : nyOffset(instant),
      ).context,
    );
    expect(hydrate(receiver, decoded)).toEqual({ applied: [span(march5)] });
    expect(receiver.get(ID, dailyRange)).toEqual({
      timestamps: new Float64Array([march5]),
      fields: { value: new Float64Array([Number.NaN]) },
      coverage: [span(march5)],
      misses: [miss(span(march6 + (shift === march6 ? HOUR : 0), march9))],
    });
    expect(receiver.snapshot(ID, dailyRange).segments).toMatchObject([
      { start: march5, count: 1 },
    ]);
  },
);

function fromJson(snapshot: Snapshot): Snapshot {
  return decodeSnapshot(JSON.parse(JSON.stringify(encodeSnapshot(snapshot))));
}

it("14: fixed snapshot JSON keeps the 0.1.0 encoding and NaN survives hydrate", () => {
  const writer = engine(10, fixedOptions);
  writer.put(ID, batch([3, 23], [1, Number.NaN]));
  const snapshot = writer.snapshot(ID, fixedRange);
  expect(encodeSnapshot(snapshot)).toEqual({
    ...fixedGolden,
    segments: [
      {
        ...fixedGolden.segments[0],
        mask: "BQ==",
        fields: [
          {
            name: "value",
            dtype: "f64",
            data: "AAAAAAAA8D8AAAAAAAAAAAAAAAAAAPh/",
          },
        ],
      },
    ],
  });
  const reader = engine(10, fixedOptions);
  expect(hydrate(reader, fromJson(snapshot))).toEqual({
    applied: [fixedRange],
  });
  expect(reader.get(ID, fixedRange)).toEqual(writer.get(ID, fixedRange));
});

it("14: calendar snapshot JSON preserves its grid, anchor slots and NaN", () => {
  const writer = engine(daily);
  writer.put(ID, batch([march5, march6], [Number.NaN, 6]));
  const snapshot = writer.snapshot(ID, dailyRange);
  const decoded = fromJson(snapshot);
  expect(format2(decoded)).toEqual(format2(snapshot));
  expect(format2(decoded).segments).toMatchObject([
    { format: 2, grid: daily, startSlot: 20_517 },
  ]);
  const reader = engine(daily);
  expect(hydrate(reader, decoded)).toEqual({ applied: [span(march5, march6)] });
  expect(reader.get(ID, dailyRange)).toEqual(writer.get(ID, dailyRange));
});

it.each(invalidIndexShapes)(
  "14: JSON decoder refuses $label in $field",
  (change) => {
    const writer = engine(daily);
    writer.put(ID, batch([march5]));
    const encoded = encodeSnapshot(writer.snapshot(ID, dailyRange));
    expectTscacheError(
      () => decodeSnapshot(changeIndex(encoded, change) as EncodedSnapshot),
      new RegExp(change.field),
    );
  },
);

it.each([
  { label: "unknown format", change: { format: 3 } },
  { label: "missing grid", change: { grid: undefined } },
  { label: "null grid", change: { grid: null } },
  { label: "string grid", change: { grid: NY } },
  { label: "grid without a string unit", change: { grid: { unit: 1 } } },
])("14: JSON decoder refuses $label", ({ change }) => {
  const writer = engine(daily);
  const encoded = encodeSnapshot(writer.snapshot(ID, dailyRange));
  expectTscacheError(() =>
    decodeSnapshot({ ...encoded, ...change } as unknown as EncodedSnapshot),
  );
});

it("14: the JSON decoder leaves coverage pair count and descriptor meaning for hydrate", () => {
  const writer = engine(daily);
  writer.put(ID, batch([march5]));
  const encoded = encodeSnapshot(writer.snapshot(ID, dailyRange));
  for (const change of [
    { coverageSlots: [] },
    { grid: { unit: "invented" } },
  ]) {
    const decoded = decodeSnapshot({
      ...encoded,
      ...change,
    } as EncodedSnapshot);
    expectTscacheError(() => hydrate(engine(daily), decoded));
  }
});

it.each([
  "equal",
  "different descriptor",
  "unknown cache format",
  "unknown page format",
] as const)("15: records converge after loading a %s", async (kind) => {
  const writer = engine(daily, { persist: true });
  const source = await persisted(writer);
  writer.put(ID, batch([march5, march6], [5, 6]), { range: dailyRange });
  await source.flush();
  const records = source.records();
  const cache = requireCache(records);
  expect(cache).toMatchObject({ format: 2, config: { grid: daily } });
  expect(cache.config).not.toHaveProperty("interval");
  expect(cache.config).not.toHaveProperty("alignmentOffset");
  let stored = records;
  if (kind === "unknown cache format") {
    stored = {
      ...records,
      cache: { ...cache, format: 3 } as unknown as typeof cache,
    };
  } else if (kind === "unknown page format") {
    const page = requirePage(records);
    stored = {
      ...records,
      pages: [
        {
          ...page,
          snapshot: { ...page.snapshot, format: 3 } as unknown as Snapshot,
        },
      ],
    };
  }
  const interval =
    kind === "different descriptor" ? { ...daily, at: "09:31" } : daily;
  const reader = engine(interval, { persist: true });
  const disk = await persisted(reader, stored);
  if (kind === "equal") {
    expect(reader.get(ID, dailyRange)).toEqual(writer.get(ID, dailyRange));
    // Compare actual records written by the reader, independent of the seeded disk.
    const state = cacheStateOf(reader, ID);
    expect({
      cache: cacheRecordOf(state),
      pages: pageRecordsOf(state),
    }).toEqual(records);
  } else {
    expect(reader.get(ID, dailyRange)).toMatchObject({
      timestamps: new Float64Array(),
      coverage: [],
    });
  }
  await disk.flush();
  expect(disk.records()).toEqual(
    kind === "equal" ? records : { cache: undefined, pages: [] },
  );
});
