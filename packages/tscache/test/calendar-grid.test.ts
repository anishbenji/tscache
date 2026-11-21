import { expect, it } from "vitest";
import { InvalidRangeError } from "../src/errors";
import {
  isAligned,
  msOf,
  slotAtOrAfter,
  slotOf,
  snapIn,
  snapOut,
  toMs,
} from "../src/grid";
import { rng } from "./cache-model";
import {
  APIA,
  apiaOffset,
  type CalendarDescriptor,
  calendarGrid,
  DAY,
  daySlot,
  floorSlot,
  HOUR,
  NY,
  nyOffset,
  probe,
  span,
  startOf,
  utc,
} from "./calendar-contract-helpers";

const minDay = daySlot("0001-01-01");
const maxDay = daySlot("9999-12-31");

const boundaries = [
  {
    descriptor: { unit: "day" },
    min: minDay,
    max: maxDay,
    first: "0001-01-01",
    last: "9999-12-31",
    next: "+010000-01-01",
  },
  {
    descriptor: { unit: "week", weekStart: 1 },
    min: (minDay + 3) / 7,
    max: (maxDay - 1) / 7,
    first: "0001-01-01",
    last: "9999-12-27",
    next: "+010000-01-03",
  },
  {
    descriptor: { unit: "week", weekStart: 7 },
    min: (minDay + 10) / 7,
    max: (maxDay - 1) / 7,
    first: "0001-01-07",
    last: "9999-12-26",
    next: "+010000-01-02",
  },
  {
    descriptor: { unit: "month" },
    min: -23_628,
    max: 96_359,
    first: "0001-01-01",
    last: "9999-12-01",
    next: "+010000-01-01",
  },
  {
    descriptor: { unit: "quarter" },
    min: -7_876,
    max: 32_119,
    first: "0001-01-01",
    last: "9999-10-01",
    next: "+010000-01-01",
  },
  {
    descriptor: { unit: "year" },
    min: -1_969,
    max: 8_029,
    first: "0001-01-01",
    last: "9999-01-01",
    next: "+010000-01-01",
  },
] as const satisfies readonly {
  descriptor: CalendarDescriptor;
  min: number;
  max: number;
  first: string;
  last: string;
  next: string;
}[];

const londonOffset = (t: number) =>
  t >= utc("2026-03-29T01:00Z") && t < utc("2026-10-25T01:00Z") ? HOUR : 0;
const lordHoweOffset = (t: number) =>
  t >= utc("2026-04-04T15:00Z") && t < utc("2026-10-03T15:30Z")
    ? 10.5 * HOUR
    : 11 * HOUR;
const kwajaleinOffset = (t: number) =>
  t < utc("1993-08-21T12:00Z") ? -12 * HOUR : 12 * HOUR;

function checkSlot(
  g: ReturnType<typeof calendarGrid>,
  slot: number,
  offset: number,
): void {
  const start = startOf(slot, g);
  const next = startOf(slot + 1, g);
  expect(next).toBeGreaterThan(start);
  expect(floorSlot(start, g)).toBe(slot);
  expect(floorSlot(next - 1, g)).toBe(slot);
  expect(floorSlot(start + Math.min(offset, next - start - 1), g)).toBe(slot);
}

it("2: seeded slots and instants partition every unit in UTC and with injected offsets", () => {
  const random = rng(129_002);
  for (const { descriptor, min, max } of boundaries) {
    for (const injected of [false, true]) {
      const g = injected
        ? calendarGrid(
            { ...descriptor, zone: NY, at: "09:30" },
            probe(nyOffset).context,
          )
        : calendarGrid(descriptor);
      for (const slot of [
        min,
        -1,
        0,
        1,
        max,
        ...Array.from({ length: 35 }, () => random.int(min, max)),
      ]) {
        checkSlot(g, slot, random.int(0, 370 * DAY));
      }
    }
  }
});

it.each([
  {
    zone: NY,
    first: "2026-01-01T23:00Z",
    last: "2026-12-31",
    offset: nyOffset,
  },
  {
    zone: "Europe/London",
    first: "2026-01-01T23:00Z",
    last: "2026-12-31",
    offset: londonOffset,
  },
  {
    zone: "Australia/Lord_Howe",
    first: "2026-01-01T23:00Z",
    last: "2026-12-31",
    offset: lordHoweOffset,
  },
  {
    zone: "Asia/Kathmandu",
    first: "2026-01-01T23:00Z",
    last: "2026-12-31",
    offset: () => 5.75 * HOUR,
  },
  {
    zone: APIA,
    first: "2011-12-28",
    last: "2012-01-02",
    offset: apiaOffset(utc("2011-12-30T10:00Z")),
  },
  {
    zone: "Pacific/Kwajalein",
    first: "1993-08-19",
    last: "1993-08-23",
    offset: kwajaleinOffset,
  },
])(
  "2/4/6: real Intl and injected offsets agree at settled $zone unit edges",
  ({ zone, first, last, offset }) => {
    const random = rng(129_004);
    for (const { descriptor } of boundaries) {
      const dateRange =
        [APIA, "Pacific/Kwajalein"].includes(zone) && descriptor.unit !== "day"
          ? [{ at: "00:00", first, last }]
          : [
              { at: "00:00", first, last },
              { at: "09:30", first, last },
            ];
      for (const { at } of dateRange) {
        const real = calendarGrid({ ...descriptor, zone, at });
        const injected = calendarGrid(
          { ...descriptor, zone, at },
          probe(offset).context,
        );
        for (const stamp of [
          utc(first),
          utc(last),
          ...Array.from({ length: 12 }, () =>
            random.int(utc(first), utc(last)),
          ),
        ]) {
          const slot = floorSlot(stamp, real);
          expect(floorSlot(stamp, injected)).toBe(slot);
          checkSlot(real, slot, random.int(0, DAY));
          checkSlot(injected, slot, random.int(0, DAY));
          if (
            descriptor.unit === "day" ||
            ![APIA, "Pacific/Kwajalein"].includes(zone)
          ) {
            expect(startOf(slot, injected)).toBe(startOf(slot, real));
          }
        }
      }
    }
  },
);

it("2: slot zero contains the epoch date, and leap years and unit changes retain their dates", () => {
  const origins = [
    "1970-01-01",
    "1969-12-29",
    "1969-12-28",
    "1970-01-01",
    "1970-01-01",
    "1970-01-01",
  ];
  for (const [{ descriptor }, origin] of boundaries.map(
    (entry, index) => [entry, origins[index] as string] as const,
  )) {
    const g = calendarGrid(descriptor);
    expect(startOf(0, g)).toBe(utc(origin));
    expect(floorSlot(utc("1970-01-01"), g)).toBe(0);
    expect(floorSlot(utc(origin) - 1, g)).toBe(-1);
  }

  const months = calendarGrid({ unit: "month" });
  for (const [slot, start, next] of [
    [1, "1970-02-01", "1970-03-01"],
    [361, "2000-02-01", "2000-03-01"],
    [1561, "2100-02-01", "2100-03-01"],
    [-1, "1969-12-01", "1970-01-01"],
    [3, "1970-04-01", "1970-05-01"],
  ] as const) {
    expect(startOf(slot, months)).toBe(utc(start));
    expect(startOf(slot + 1, months)).toBe(utc(next));
    expect(floorSlot(utc(next) - 1, months)).toBe(slot);
  }
});

it("2: floor walks at most one slot forward or two back from its UTC candidate", () => {
  const steps: number[] = [];
  const { context } = probe(() => -8 * HOUR, {
    onFloorStep: (direction) => steps.push(direction),
  });
  const g = calendarGrid(
    { unit: "day", zone: "America/Los_Angeles", at: "18:00" },
    context,
  );
  expect(floorSlot(utc("2026-01-15T00:30Z"), g)).toBe(daySlot("2026-01-13"));
  expect(steps).toEqual([-1, -1]);

  const east = probe(() => 14 * HOUR, {
    onFloorStep: (direction) => steps.push(direction),
  });
  const gEast = calendarGrid({ unit: "day", zone: APIA }, east.context);
  steps.length = 0;
  expect(floorSlot(utc("2026-01-15T23:30Z"), gEast)).toBe(
    daySlot("2026-01-16"),
  );
  expect(steps).toEqual([1]);

  const random = rng(129_102);
  for (const { descriptor } of boundaries) {
    const instrumented = calendarGrid(
      { ...descriptor, zone: APIA },
      east.context,
    );
    for (let i = 0; i < 20; i++) {
      steps.length = 0;
      floorSlot(random.int(-31_536_000_000, 1_800_000_000_000), instrumented);
      expect(steps.filter((step) => step === 1).length).toBeLessThanOrEqual(1);
      expect(steps.filter((step) => step === -1).length).toBeLessThanOrEqual(2);
    }
  }
});

it("3: New York's daily session keeps 09:30 on both sides of spring DST", () => {
  const g = calendarGrid({ unit: "day", zone: NY, at: "09:30" });
  for (const [date, stamp] of [
    ["2026-03-06", "2026-03-06T14:30Z"],
    ["2026-03-09", "2026-03-09T13:30Z"],
    ["2026-11-02", "2026-11-02T14:30Z"],
  ] as const) {
    expect(startOf(daySlot(date), g)).toBe(utc(stamp));
    expect(isAligned(utc(stamp), g)).toBe(true);
  }
  expect(isAligned(utc("2026-03-09T14:30Z"), g)).toBe(false);
});

it.each([
  { zone: NY, at: "02:30", date: "2026-03-08", expected: "2026-03-08T07:30Z" },
  { zone: NY, at: "01:30", date: "2026-11-01", expected: "2026-11-01T05:30Z" },
  {
    zone: "Australia/Lord_Howe",
    at: "02:15",
    date: "2026-10-04",
    expected: "2026-10-03T15:45Z",
  },
  {
    zone: "Australia/Lord_Howe",
    at: "01:45",
    date: "2026-04-05",
    expected: "2026-04-04T14:45Z",
  },
  {
    zone: "Asia/Kathmandu",
    at: "09:30",
    date: "2026-03-08",
    expected: "2026-03-08T03:45Z",
  },
])(
  "4: $zone $date $at resolves to $expected",
  ({ zone, at, date, expected }) => {
    const g = calendarGrid({ unit: "day", zone, at });
    expect(startOf(daySlot(date), g)).toBe(utc(expected));
    expect(slotOf(utc(expected), g)).toBe(daySlot(date));
    if (date === "2026-11-01")
      expect(isAligned(utc("2026-11-01T06:30Z"), g)).toBe(false);
  },
);

it.each([
  { zone: APIA, skipped: "2011-12-30", jump: "2011-12-30T10:00Z" },
  {
    zone: "Pacific/Kwajalein",
    skipped: "1993-08-21",
    jump: "1993-08-21T12:00Z",
  },
])(
  "4: $zone gives the skipped date its own final millisecond",
  ({ zone, skipped, jump }) => {
    const g = calendarGrid({ unit: "day", zone });
    const slot = daySlot(skipped);
    const next = utc(jump);
    expect(startOf(slot - 1, g)).toBe(next - DAY);
    expect(startOf(slot, g)).toBe(next - 1);
    expect(startOf(slot + 1, g)).toBe(next);
    const coverage = toMs(span(slot - 1, slot), g);
    expect(coverage).toEqual(span(next - DAY, next - 1));
    expect(snapOut(coverage, g)).toEqual(span(slot - 1, slot));
    expect(floorSlot(next, g)).toBe(slot + 1);
  },
);

it.each([24, 25])(
  "4: an injected %i-hour noon jump cannot reverse or collapse starts",
  (hours) => {
    const before = (14 - hours) * HOUR;
    const jump = utc("2026-06-10T12:00Z") - before;
    const { context } = probe((instant) =>
      instant < jump ? before : 14 * HOUR,
    );
    const g = calendarGrid({ unit: "day", zone: APIA, at: "18:00" }, context);
    const slot = daySlot("2026-06-10");
    expect(startOf(slot, g)).toBe(utc("2026-06-11T04:00Z") - 1);
    for (let k = slot - 1; k <= slot + 1; k++) checkSlot(g, k, 1);
  },
);

it("5a: primitives reject outside the outer bound without offset lookups", () => {
  const { context, lookups } = probe(nyOffset);
  const g = calendarGrid({ unit: "day", zone: NY, at: "09:30" }, context);
  for (const t of [
    8_640_000_000_000_001,
    9_000_000_000_000_000,
    utc("0001-01-01T09:30Z") - DAY - 1,
    utc("+010000-01-01T09:30Z") + DAY + 1,
  ]) {
    expect(() => floorSlot(t, g)).toThrow(InvalidRangeError);
    expect(isAligned(t, g)).toBe(false);
    expect(() => snapOut(span(t), g)).toThrow(InvalidRangeError);
    expect(() => snapIn(span(t), g)).toThrow(InvalidRangeError);
    expect(() => slotAtOrAfter(t, g)).toThrow(InvalidRangeError);
  }
  for (const k of [minDay - 3, maxDay + 3])
    expect(() => startOf(k, g)).toThrow(InvalidRangeError);
  expect(lookups).toEqual([]);
  for (const k of [minDay - 1, maxDay + 1])
    expect(() => toMs(span(k), g)).toThrow(InvalidRangeError);
});

it("5b: New York's final day includes instants in year 10000, with a bounded rejection beyond it", () => {
  const { context, lookups } = probe(nyOffset);
  const g = calendarGrid({ unit: "day", zone: NY, at: "09:30" }, context);
  const next = utc("+010000-01-01T14:30Z");
  for (const t of [next - 1, utc("+010000-01-01T00:00Z")])
    expect(floorSlot(t, g)).toBe(maxDay);
  for (const t of [next, utc("+010000-01-02T00:00Z"), startOf(minDay, g) - 1]) {
    lookups.length = 0;
    expect(() => floorSlot(t, g)).toThrow(InvalidRangeError);
    expect(lookups.length).toBeLessThanOrEqual(12);
  }
  expect(floorSlot(startOf(minDay, g), g)).toBe(minDay);
});

it.each([
  {
    zone: "UTC",
    weekStart: 5,
    last: "9999-12-31T00:00Z",
    inside: "+010000-01-05T00:00Z",
    next: "+010000-01-07T00:00Z",
  },
  {
    zone: NY,
    weekStart: 1,
    last: "9999-12-27T05:00Z",
    inside: "+010000-01-03T04:00Z",
    next: "+010000-01-03T05:00Z",
  },
] as const)(
  "5b: the last $zone week may reach into year 10000",
  ({ zone, weekStart, last, inside, next }) => {
    const g = calendarGrid(
      { unit: "week", zone, weekStart },
      probe(nyOffset).context,
    );
    const lastSlot = slotOf(utc(last), g);
    expect(floorSlot(utc(inside), g)).toBe(lastSlot);
    expect(floorSlot(utc(next) - 1, g)).toBe(lastSlot);
    expect(() => floorSlot(utc(next), g)).toThrow(InvalidRangeError);
    expect(() => slotAtOrAfter(utc(inside), g)).toThrow(InvalidRangeError);
  },
);

it.each([
  {
    descriptor: { unit: "week", zone: "Europe/London" },
    slot: 2930,
    stamp: "2026-02-23T00:00Z",
  },
  {
    descriptor: { unit: "week", zone: "Europe/London" },
    slot: 2948,
    stamp: "2026-06-28T23:00Z",
  },
  {
    descriptor: { unit: "month", zone: NY, at: "09:30" },
    slot: 675,
    stamp: "2026-04-01T13:30Z",
  },
  {
    descriptor: { unit: "quarter", zone: NY, at: "09:30" },
    slot: 225,
    stamp: "2026-04-01T13:30Z",
  },
  {
    descriptor: { unit: "year", zone: NY, at: "09:30" },
    slot: 56,
    stamp: "2026-01-01T14:30Z",
  },
] as const)(
  "6: slot $slot starts at $stamp in its zone",
  ({ descriptor, slot, stamp }) => {
    const g = calendarGrid(descriptor);
    expect(startOf(slot, g)).toBe(utc(stamp));
    expect(slotOf(utc(stamp), g)).toBe(slot);
  },
);

it("7: calendar snaps preserve inclusive ends and empty inward ranges", () => {
  const g = calendarGrid({ unit: "month" });
  const feb = utc("2024-02-01");
  const mar = utc("2024-03-01");
  const apr = utc("2024-04-01");
  expect(snapOut(span(feb), g)).toEqual(span(649));
  expect(snapOut(span(mar - 1), g)).toEqual(span(649, 650));
  expect(snapIn(span(feb), g)).toEqual(span(649));
  expect(snapIn(span(mar - 1), g)).toBeUndefined();
  expect(snapIn(span(feb + 1, apr - 1), g)).toEqual(span(650));
  expect(toMs(snapOut(span(feb + 1, apr - 1), g), g)).toEqual(span(feb, apr));
  expect(slotAtOrAfter(utc("2024-02-15"), g)).toBe(650);
  expect(slotAtOrAfter(mar, g)).toBe(650);
  expect(msOf(650, g)).toBe(mar);
});

// Compute the nominal dates near an edge without using the grid under test.
function nominalEdge(
  date: string,
  unit: CalendarDescriptor["unit"],
  step: number,
): number {
  const value = new Date(utc(date));
  switch (unit) {
    case "day":
      return value.getTime() + step * DAY;
    case "week":
      return value.getTime() + step * 7 * DAY;
    case "month":
      return value.setUTCMonth(value.getUTCMonth() + step);
    case "quarter":
      return value.setUTCMonth(value.getUTCMonth() + step * 3);
    case "year":
      return value.setUTCFullYear(value.getUTCFullYear() + step);
  }
}

it.each(boundaries)(
  "8: $descriptor converts both edge slots and exactly two margin starts",
  ({ descriptor, min, max, first, last, next }) => {
    for (const zone of ["UTC", NY]) {
      const { context, lookups } = probe(() => -5 * HOUR);
      const g = calendarGrid({ ...descriptor, zone }, context);
      const shift = zone === NY ? 5 * HOUR : 0;
      expect(startOf(min, g)).toBe(utc(first) + shift);
      expect(startOf(max, g)).toBe(utc(last) + shift);
      expect(slotOf(utc(first) + shift, g)).toBe(min);
      expect(slotOf(utc(last) + shift, g)).toBe(max);
      expect(floorSlot(utc(next) + shift - 1, g)).toBe(max);
      expect(startOf(min - 2, g)).toBeLessThan(utc(first) + shift);
      expect(startOf(max + 2, g)).toBeGreaterThan(utc(next) + shift);
      const count = lookups.length;
      expect(() => startOf(min - 3, g)).toThrow(InvalidRangeError);
      expect(() => startOf(max + 3, g)).toThrow(InvalidRangeError);
      expect(lookups).toHaveLength(count);
      const permittedDates = [
        ...[-2, -1, 0, 1, 2, 3].map((step) =>
          nominalEdge(first, descriptor.unit, step),
        ),
        ...[-3, -2, -1, 0, 1, 2, 3].map((step) =>
          nominalEdge(last, descriptor.unit, step),
        ),
      ];
      for (const lookup of lookups) {
        expect(
          permittedDates.some((nominal) => Math.abs(lookup - nominal) <= DAY),
        ).toBe(true);
      }
      expect(() => snapOut(span(utc(first) + shift - 1), g)).toThrow(
        InvalidRangeError,
      );
      expect(() => slotAtOrAfter(utc(next) + shift, g)).toThrow(
        InvalidRangeError,
      );
    }
  },
);
