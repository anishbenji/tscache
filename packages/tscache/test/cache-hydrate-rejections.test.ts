// Step 148, decision #142 A: describe rejected values by type, including
// finite numbers. A caller logging the error should not log a numeric
// identifier or timestamp supplied as the rejected value either.
import { describe, expect, it, vi } from "vitest";
import { CacheState } from "../src/engine/cache";
import { resolveCacheConfig } from "../src/engine/validate";
import { TscacheError } from "../src/errors";
import { segmentFromPayload } from "../src/segment/payload";
import type { DenseSegmentPayload, Snapshot } from "../src/types";
import {
  batch,
  cache,
  malformedRanges,
  observe,
  result,
} from "./cache-test-helpers";
import {
  engine as calendarEngine,
  DAY,
  format2,
  hydrate,
  ID,
  span,
  utc,
} from "./calendar-contract-helpers";
import {
  payloadField,
  snapshotFixture,
  snapshotPayload,
  thrown,
} from "./snapshot-test-helpers";

type Corruption = { name: string; change: (s: Snapshot) => unknown };
const envelope: Corruption[] = [
  ...[undefined, null, 1, "snapshot", []].map((value) => ({
    name: `non-object ${JSON.stringify(value)}`,
    change: () => value,
  })),
  ...[undefined, 0, 2, "1"].map((format) => ({
    name: `format ${String(format)}`,
    change: (s: Snapshot) => ({ ...s, format }),
  })),
  ...[undefined, 11, "10", Number.NaN].map((interval) => ({
    name: `interval ${String(interval)}`,
    change: (s: Snapshot) => ({ ...s, interval }),
  })),
  ...[undefined, 0, "3", Number.NaN].map((alignmentOffset) => ({
    name: `offset ${String(alignmentOffset)}`,
    change: (s: Snapshot) => ({ ...s, alignmentOffset }),
  })),
  ...[
    undefined,
    null,
    [],
    {},
    { price: "f64" },
    { price: "f64", volume: "i16", extra: "u8" },
    { price: "f32", volume: "i16" },
    { price: "f64", renamed: "i16" },
  ].map((fields) => ({
    name: `fields ${JSON.stringify(fields)}`,
    change: (s: Snapshot) => ({ ...s, fields }),
  })),
];
const metadata: Corruption[] = [
  ...["", null, 1, false].map((version) => ({
    name: `version ${JSON.stringify(version)}`,
    change: (s: Snapshot) => ({ ...s, version }),
  })),
  ...[
    null,
    "63",
    false,
    Number.NaN,
    Infinity,
    -Infinity,
    2 ** 53,
    -(2 ** 53),
    Number.MAX_SAFE_INTEGER,
  ].map((finalizedUntil) => ({
    name: `watermark ${String(finalizedUntil)}`,
    change: (s: Snapshot) => ({ ...s, finalizedUntil }),
  })),
];
const coverage: Corruption[] = [
  ...[undefined, null, {}, "coverage"].map((value) => ({
    name: `coverage collection ${String(value)}`,
    change: (s: Snapshot) => ({ ...s, coverage: value }),
  })),
  ...[
    null,
    {},
    { start: 3 },
    { end: 43 },
    { start: "3", end: 43 },
    { start: 3, end: Number.NaN },
    { start: -Infinity, end: 43 },
    { start: 3, end: 2 ** 53 },
    { start: 3.5, end: 43 },
    { start: 4, end: 43 },
    { start: 3, end: 44 },
    { start: 43, end: 3 },
    { start: -17, end: 43 },
    { start: 3, end: 83 },
  ].map((range) => ({
    name: `coverage range ${JSON.stringify(range)}`,
    change: (s: Snapshot) => ({ ...s, coverage: [range] }),
  })),
  {
    name: "descending coverage",
    change: (s) => ({
      ...s,
      coverage: [
        { start: 33, end: 43 },
        { start: 3, end: 13 },
      ],
    }),
  },
  {
    name: "overlapping coverage",
    change: (s) => ({
      ...s,
      coverage: [
        { start: 3, end: 23 },
        { start: 23, end: 43 },
      ],
    }),
  },
  {
    name: "adjacent coverage",
    change: (s) => ({
      ...s,
      coverage: [
        { start: 3, end: 13 },
        { start: 23, end: 43 },
      ],
    }),
  },
];
const payloads: Corruption[] = [
  ...[null, 1, {}].map((value) => ({
    name: `payload ${JSON.stringify(value)}`,
    change: (s: Snapshot) => ({ ...s, segments: [value] }),
  })),
  ...Object.entries({
    format: 2,
    layout: "columnar",
    interval: 11,
    alignmentOffset: 0,
    start: 4,
  }).map(([key, value]) => ({
    name: `payload ${key}`,
    change: (s: Snapshot) => ({
      ...s,
      segments: [{ ...snapshotPayload(), [key]: value }],
    }),
  })),
  ...[undefined, 0, -1, 1.5, Number.NaN, Infinity, 2 ** 53].map((count) => ({
    name: `payload count ${String(count)}`,
    change: (s: Snapshot) => ({
      ...s,
      segments: [{ ...snapshotPayload(), count }],
    }),
  })),
  {
    name: "payload one past receiver cap",
    change: (s) => ({
      ...s,
      segments: [
        {
          ...snapshotPayload(),
          count: 9,
          mask: new Uint8Array([1, 1]),
          fields: [
            { name: "price", dtype: "f64", data: new ArrayBuffer(72) },
            { name: "volume", dtype: "i16", data: new ArrayBuffer(18) },
          ],
        },
      ],
    }),
  },
  ...[
    undefined,
    [21],
    new Uint16Array([21]),
    new ArrayBuffer(1),
    new Uint8Array(),
    new Uint8Array([21, 0]),
    new Uint8Array([0x95]),
  ].map((mask, index) => ({
    name: `payload mask ${index}`,
    change: (s: Snapshot) => ({
      ...s,
      segments: [{ ...snapshotPayload(), mask }],
    }),
  })),
  ...[
    undefined,
    null,
    {},
    [],
    [null],
    [snapshotPayload().fields[0]],
    [
      ...snapshotPayload().fields,
      { name: "extra", dtype: "u8", data: new ArrayBuffer(5) },
    ],
    [null, snapshotPayload().fields[1]],
  ].map((fields, index) => ({
    name: `payload fields ${index}`,
    change: (s: Snapshot) => ({
      ...s,
      segments: [{ ...snapshotPayload(), fields }],
    }),
  })),
  ...[
    "duplicate",
    "renamed",
    "dtype",
    "short",
    "long",
    "view",
    "missing data",
  ].map((kind) => ({
    name: `payload field ${kind}`,
    change: (s: Snapshot) => {
      const p = snapshotPayload();
      const f = payloadField(p, "volume");
      const replacement =
        kind === "duplicate"
          ? { ...f, name: "price" }
          : kind === "renamed"
            ? { ...f, name: "other" }
            : kind === "dtype"
              ? { ...f, dtype: "u16" }
              : {
                  ...f,
                  data:
                    kind === "short"
                      ? new ArrayBuffer(9)
                      : kind === "long"
                        ? new ArrayBuffer(11)
                        : kind === "view"
                          ? new Int16Array(5)
                          : undefined,
                };
      return { ...s, segments: [{ ...p, fields: [p.fields[0], replacement] }] };
    },
  })),
];
const segments: Corruption[] = [
  ...[undefined, null, {}, "segments"].map((value) => ({
    name: `segments collection ${String(value)}`,
    change: (s: Snapshot) => ({ ...s, segments: value }),
  })),
  {
    name: "extent before request",
    change: (s) => ({ ...s, segments: [{ ...snapshotPayload(), start: -17 }] }),
  },
  {
    name: "extent after request",
    change: (s) => ({ ...s, segments: [{ ...snapshotPayload(), start: 43 }] }),
  },
  {
    name: "descending extents",
    change: (s) => ({
      ...s,
      segments: [snapshotPayload(), { ...snapshotPayload(), start: -7 }],
    }),
  },
  {
    name: "overlapping extents",
    change: (s) => ({
      ...s,
      segments: [snapshotPayload(), { ...snapshotPayload(), start: 33 }],
    }),
  },
  {
    name: "duplicate extents",
    change: (s) => ({ ...s, segments: [snapshotPayload(), snapshotPayload()] }),
  },
  {
    name: "segment with no present point",
    change: (s) => ({
      ...s,
      segments: [{ ...snapshotPayload(), mask: new Uint8Array([0]) }],
    }),
  },
];

function receiver(version?: string) {
  const onVersionClear = vi.fn();
  const c = new CacheState(
    resolveCacheConfig({
      id: "rejections",
      interval: 10,
      alignmentOffset: 3,
      fields: { price: "f64", volume: "i16" },
      segmentSlotCap: 8,
      finalizedUntil: 33,
      ...(version === undefined ? {} : { version }),
    }),
    { onVersionClear },
  );
  c.put(batch([-7, 3, 13, 23, 33, 73]));
  return { c, onVersionClear };
}

function rejectUnchanged(input: unknown, payloadFailure = false) {
  // Also pin full validation before the version precondition can skip a stale seed.
  for (const version of [undefined, "live"]) {
    const { c, onVersionClear } = receiver(version);
    const before = observe(c);
    const error = thrown(() => c.hydrate(input as Snapshot));
    expect(error.message).toMatch(
      payloadFailure ? /^invalid segment payload:/ : /^invalid snapshot:/,
    );
    expect(observe(c)).toEqual(before);
    expect(onVersionClear).not.toHaveBeenCalled();
  }
}

describe("hydrate validates in full before changing state — architecture §4.5", () => {
  it.each(envelope)(
    "V01 rejects envelope: $name, even with no segments",
    ({ change }) => {
      rejectUnchanged(change({ ...snapshotFixture(), segments: [] }));
    },
  );
  it.each([
    ...malformedRanges,
    undefined,
    { start: Number.MAX_SAFE_INTEGER, end: Number.MAX_SAFE_INTEGER },
  ])("V02 rejects request range %j", (range) => {
    rejectUnchanged({ ...snapshotFixture(), range });
  });
  it.each(metadata)("V03 rejects metadata: $name", ({ change }) =>
    rejectUnchanged(change(snapshotFixture())),
  );
  it.each(coverage)("V04 rejects coverage: $name", ({ change }) =>
    rejectUnchanged(change(snapshotFixture())),
  );
  it.each(segments)("V05 rejects segments: $name", ({ change }) =>
    rejectUnchanged(change(snapshotFixture())),
  );
  it.each(payloads)(
    "V06 preserves payload decoder errors: $name",
    ({ change }) => rejectUnchanged(change(snapshotFixture()), true),
  );

  it.each([
    "format",
    "layout",
    "start",
    "count",
    "interval",
    "alignmentOffset",
    "mask",
    "fields",
  ])("V11 rejects payload with missing %s", (key) => {
    const p = Object.fromEntries(
      Object.entries(snapshotPayload()).filter(([name]) => name !== key),
    );
    rejectUnchanged({ ...snapshotFixture(), segments: [p] }, true);
  });

  it("V12 preserves the documented segment decoder's exact error message", () => {
    const { c, onVersionClear } = receiver();
    const before = observe(c);
    const invalid = {
      ...snapshotPayload(),
      format: 2,
    } as unknown as DenseSegmentPayload;
    const expected = thrown(() =>
      segmentFromPayload(invalid, {
        grid: c.grid,
        fields: c.config.fields,
        slotCap: c.config.segmentSlotCap,
      }),
    );
    const actual = thrown(() =>
      c.hydrate({ ...snapshotFixture(), segments: [invalid] }),
    );
    expect(actual.message).toBe(expected.message);
    expect(observe(c)).toEqual(before);
    expect(onVersionClear).not.toHaveBeenCalled();
  });

  it("V07 checks every payload before applying even the first valid part or metadata", () => {
    const s = snapshotFixture();
    // N69 (decision 30) rejects coverage at or after the snapshot's own
    // watermark before any payload is decoded; a watermark above the second
    // range keeps that coverage legal, so the payload is still what fails.
    s.finalizedUntil = 83;
    s.coverage = [
      { start: 3, end: 43 },
      { start: 63, end: 73 },
    ];
    s.segments.push({
      ...snapshotPayload(),
      format: 2,
      start: 63,
    } as unknown as Snapshot["segments"][number]);
    rejectUnchanged(s, true);
  });

  it("V08 rejects a payload whose last timestamp exceeds the safe-integer domain", () => {
    const { c } = receiver();
    const before = observe(c);
    const p: DenseSegmentPayload = {
      ...snapshotPayload(),
      start: 9_007_199_254_740_983,
      count: 2,
      mask: new Uint8Array([3]),
      fields: [
        { name: "price", dtype: "f64", data: new ArrayBuffer(16) },
        { name: "volume", dtype: "i16", data: new ArrayBuffer(4) },
      ],
    };
    const error = thrown(() =>
      c.hydrate({ ...snapshotFixture(), segments: [p] }),
    );
    expect(error.message).toMatch(/^invalid segment payload:/);
    expect(observe(c)).toEqual(before);
  });

  it.each([0, 1, 2, 3])(
    "V09 validation stage %i precedes every later stage",
    (stage) => {
      const changes = [
        (s: Snapshot) => ({ ...s, format: 2 }) as unknown as Snapshot,
        (s: Snapshot) => ({ ...s, range: { start: 43, end: 3 } }),
        (s: Snapshot) => ({ ...s, version: "" }),
        (s: Snapshot) => ({ ...s, coverage: [{ start: 3.5, end: 43 }] }),
        (s: Snapshot) =>
          ({
            ...s,
            segments: [{ ...snapshotPayload(), format: 2 }],
          }) as unknown as Snapshot,
      ];
      const change = changes[stage];
      if (!change) throw new Error("Missing validation stage");
      const { c } = receiver();
      const before = observe(c);
      const isolated = thrown(() => c.hydrate(change(snapshotFixture())));
      let combined = snapshotFixture();
      for (const later of changes.slice(stage)) combined = later(combined);
      const error = thrown(() => c.hydrate(combined));
      expect(error.message).toBe(isolated.message);
      expect(error.message).toMatch(/^invalid snapshot:/);
      expect(observe(c)).toEqual(before);
    },
  );

  it("V10 validates segment extents even when the points lie outside snapshot coverage", () => {
    rejectUnchanged({
      ...snapshotFixture(),
      coverage: [],
      segments: [{ ...snapshotPayload(), start: 43 }],
    });
  });
});

describe("hydrate error text — step 148", () => {
  const marker = "SNAPSHOT-TEXT-MARKER-148";
  const markerInput = { label: "marker string", value: marker, kind: "string" };
  const nan = { label: "NaN", value: Number.NaN, kind: "number" };
  const infinity = { label: "Infinity", value: Infinity, kind: "number" };
  const finite = {
    label: "a finite number",
    value: 987_654_321,
    kind: "number",
  };
  const numericFieldInputs = [markerInput, nan, infinity, finite];
  const gridFields = ["format", "interval", "alignmentOffset"];
  const gridErrors = gridFields.flatMap((field) =>
    numericFieldInputs.map((input) => ({ field, ...input })),
  );

  function expectTypeOnly(
    action: () => unknown,
    prefix: RegExp,
    { field, kind, value }: { field: string; kind: string; value: unknown },
  ) {
    const { message } = thrown(action);
    expect(message).toMatch(prefix);
    expect(message).toMatch(new RegExp(`\\b${field}\\b`));
    expect(message).not.toContain(marker);
    if (typeof value === "number") expect(message).not.toContain(String(value));
    // An expected type (e.g. "must be a number") does not identify what arrived.
    expect(message).toMatch(
      new RegExp(
        `\\b(?:got|received|found) (?:an? )?(?:empty |(?:non-)?finite )?${kind}\\b`,
      ),
    );
  }

  it.each(gridErrors)(
    "V13 names the received type of envelope $field for $label without quoting it",
    (failure) => {
      const { c } = receiver();
      const { field, value } = failure;
      const input = { ...snapshotFixture(), [field]: value } as Snapshot;
      expectTypeOnly(() => c.hydrate(input), /^invalid snapshot:/, failure);
    },
  );

  it.each([
    ...gridErrors,
    { field: "layout", ...markerInput },
    ...numericFieldInputs.map((input) => ({ field: "start", ...input })),
    ...[markerInput, nan, infinity, { ...finite, value: -finite.value }].map(
      (input) => ({ field: "count", ...input }),
    ),
  ])(
    "V14 names the received type of payload $field for $label without quoting it",
    (failure) => {
      const { c } = receiver();
      const { field, value } = failure;
      const payload = { ...snapshotPayload(), [field]: value };
      const input = { ...snapshotFixture(), segments: [payload] } as Snapshot;
      expectTypeOnly(
        () => c.hydrate(input),
        /^invalid segment payload:/,
        failure,
      );
    },
  );

  it.each(numericFieldInputs)(
    "V15 names the received type of calendar payload startSlot for $label without quoting it",
    (failure) => {
      const daily = { unit: "day", zone: "UTC" } as const;
      const writer = calendarEngine(daily);
      writer.put(ID, { timestamps: [DAY], fields: { value: [12] } });
      const snapshot = format2(writer.snapshot(ID, span(DAY)));
      const payload = snapshot.segments[0];
      if (payload === undefined)
        throw new Error("Missing calendar fixture segment");
      const input = {
        ...snapshot,
        segments: [{ ...payload, startSlot: failure.value }],
      };
      const reader = calendarEngine(daily);
      expectTypeOnly(
        () => hydrate(reader, input),
        /^invalid segment payload:/,
        { field: "startSlot", ...failure },
      );
    },
  );

  it("V14b refuses a positive integer count above the slot cap without printing the count", () => {
    const { c } = receiver();
    // The receiver's slot cap is 8; these digits appear nowhere else in the message.
    const count = 987_654;
    const payload = { ...snapshotPayload(), count };
    const input = { ...snapshotFixture(), segments: [payload] } as Snapshot;
    const { message } = thrown(() => c.hydrate(input));
    expect(message).toMatch(
      /^invalid segment payload: count exceeds the slot cap\b/,
    );
    expect(message).not.toContain(String(count));
  });

  it("V15b prints the validated start, not a second read of it, in the startSlot message", () => {
    const daily = { unit: "day", zone: "UTC" } as const;
    const writer = calendarEngine(daily);
    writer.put(ID, { timestamps: [DAY], fields: { value: [12] } });
    const snapshot = format2(writer.snapshot(ID, span(DAY)));
    const payload = snapshot.segments[0];
    if (payload === undefined || payload.format !== 2)
      throw new Error("Missing calendar fixture segment");
    // A valid start on the first read, the marker on every later one: an
    // Engine.hydrate caller can pass an accessor or a Proxy.
    let reads = 0;
    const segment = { ...payload, startSlot: payload.startSlot + 1 };
    Object.defineProperty(segment, "start", {
      enumerable: true,
      get: () => (reads++ === 0 ? payload.start : marker),
    });
    const input = { ...snapshot, segments: [segment] };
    const reader = calendarEngine(daily);
    const { message } = thrown(() => hydrate(reader, input));
    expect(message).toMatch(
      /^invalid segment payload: startSlot must be the slot of start\b/,
    );
    expect(message).not.toContain(marker);
  });

  it("V16 names the received type of a payload field dtype without quoting it", () => {
    const { c } = receiver();
    const payload = snapshotPayload();
    const fields = payload.fields.map((field) =>
      field.name === "volume" ? { ...field, dtype: marker } : field,
    );
    const input = {
      ...snapshotFixture(),
      segments: [{ ...payload, fields }],
    } as unknown as Snapshot;
    expectTypeOnly(() => c.hydrate(input), /^invalid segment payload:/, {
      field: "dtype",
      ...markerInput,
    });
  });

  it.each([
    // Nonempty strings are valid versions. Use an empty string for the string
    // diagnostic and put the marker in a non-string version for the leak check.
    { field: "version", label: "an empty string", value: "", kind: "string" },
    {
      field: "version",
      label: "a marker object",
      value: { marker },
      kind: "object",
    },
    { field: "version", ...finite },
    { field: "finalizedUntil", ...markerInput },
    { field: "finalizedUntil", ...nan },
    { field: "finalizedUntil", ...infinity },
    {
      field: "finalizedUntil",
      label: "a finite out-of-domain number",
      value: 2 ** 53 + 2,
      kind: "number",
    },
    {
      field: "finalizedUntil",
      label: "a finite number with no following grid point",
      value: Number.MAX_SAFE_INTEGER,
      kind: "number",
    },
  ])(
    "V17 names the received type of metadata $field for $label without quoting it",
    (failure) => {
      const { c } = receiver();
      const { field, value } = failure;
      const input = { ...snapshotFixture(), [field]: value } as Snapshot;
      expectTypeOnly(() => c.hydrate(input), /^invalid snapshot:/, failure);
    },
  );

  function onFirstRead(target: object, field: string, read: () => unknown) {
    const valid: unknown = Reflect.get(target, field);
    let reads = 0;
    Object.defineProperty(target, field, {
      enumerable: true,
      get: () => (reads++ === 0 ? read() : valid),
    });
  }

  it("V18 wraps a throwing first read of payload start without printing its value", () => {
    const { c } = receiver();
    const payload = snapshotPayload();
    const { start } = payload;
    onFirstRead(payload, "start", () => {
      throw new RangeError(marker);
    });
    const input = { ...snapshotFixture(), segments: [payload] };
    const { message } = thrown(() => c.hydrate(input));
    expect(message).toMatch(
      /^invalid segment payload: start must be an aligned safe-integer timestamp\b/,
    );
    expect(message).not.toContain(marker);
    expect(message).not.toMatch(new RegExp(`\\b${start}\\b`));
  });

  it.each([
    { location: "envelope", field: "interval", ...markerInput },
    { location: "envelope", field: "alignmentOffset", ...markerInput },
    { location: "payload", field: "interval", ...markerInput },
    { location: "payload", field: "alignmentOffset", ...markerInput },
    { location: "payload", field: "layout", ...finite },
    { location: "payload", field: "count", ...markerInput },
  ])(
    "V19 names the first-read type of $location $field without quoting it",
    (failure) => {
      const { c } = receiver();
      const payload = snapshotPayload();
      const input = { ...snapshotFixture(), segments: [payload] };
      const envelopeField = failure.location === "envelope";
      onFirstRead(
        envelopeField ? input : payload,
        failure.field,
        () => failure.value,
      );
      expectTypeOnly(
        () => c.hydrate(input),
        envelopeField ? /^invalid snapshot:/ : /^invalid segment payload:/,
        failure,
      );
    },
  );

  const dailyUtc = { unit: "day", zone: "UTC" } as const;

  function dailySnapshot() {
    const writer = calendarEngine(dailyUtc);
    writer.put(ID, { timestamps: [DAY], fields: { value: [12] } });
    return format2(writer.snapshot(ID, span(DAY)));
  }

  it("V19 names the first-read type of calendar payload startSlot without quoting it", () => {
    const input = dailySnapshot();
    const payload = input.segments[0];
    if (payload === undefined || payload.format !== 2)
      throw new Error("Missing calendar fixture segment");
    onFirstRead(payload, "startSlot", () => marker);
    const reader = calendarEngine(dailyUtc);
    expectTypeOnly(() => hydrate(reader, input), /^invalid segment payload:/, {
      field: "startSlot",
      ...markerInput,
    });
  });

  it("V19 names the first-read type of payload field dtype without quoting it", () => {
    const { c } = receiver();
    const payload = snapshotPayload();
    onFirstRead(payloadField(payload, "volume"), "dtype", () => finite.value);
    const input = { ...snapshotFixture(), segments: [payload] };
    expectTypeOnly(() => c.hydrate(input), /^invalid segment payload:/, {
      field: "dtype",
      ...finite,
    });
  });

  it("V20 names the calendar domain for a watermark before the first slot without printing a number", () => {
    const finalizedUntil = utc("0001-01-01T00:00:00.000Z") - 1;
    const input = { ...dailySnapshot(), finalizedUntil };
    const reader = calendarEngine(dailyUtc);
    const { message } = thrown(() => hydrate(reader, input));
    expect(message).toMatch(/^invalid snapshot: finalizedUntil\b/);
    expect(message).toMatch(/\bcalendar(?: grid)?(?:'s)? domain\b/i);
    expect(message).not.toMatch(/\d/);
  });

  const laterCount = 123_456;

  it.each([
    {
      field: "count",
      label: "a much larger integer",
      value: laterCount,
      derivedSizes: [laterCount / 8, laterCount * 8, laterCount * 2],
    },
    { field: "count", label: "a bigint", value: 987_654n },
    { field: "count", ...infinity },
    ...["mask", "fields", "data"].map((field) => ({ field, ...markerInput })),
  ])(
    "V21 reads payload $field once when a later read would return $label",
    ({
      field,
      value,
      derivedSizes,
    }: {
      field: string;
      value: unknown;
      derivedSizes?: number[];
    }) => {
      const c = cache({ segmentSlotCap: 8 });
      const before = observe(c);
      const payload = snapshotPayload();
      const target =
        field === "data" ? payloadField(payload, "volume") : payload;
      const valid: unknown = Reflect.get(target, field);
      let reads = 0;
      Object.defineProperty(target, field, {
        enumerable: true,
        get: () => (reads++ === 0 ? valid : value),
      });
      const input = { ...snapshotFixture(), segments: [payload] };
      const coverage = [{ start: 3, end: 43 }];

      let outcome: ReturnType<CacheState["hydrate"]>;
      try {
        outcome = c.hydrate(input);
      } catch (error) {
        if (!(error instanceof TscacheError)) throw error;
        for (const undisclosed of [value, ...(derivedSizes ?? [])]) {
          expect(error.message).not.toContain(String(undisclosed));
        }
        expect(reads).toBeLessThanOrEqual(1);
        expect(observe(c)).toEqual(before);
        return;
      }

      expect(reads).toBe(1);
      expect(outcome).toEqual({ applied: coverage });
      expect(c.get(input.range)).toEqual(
        result(
          [3, 23, 43],
          coverage,
          [
            { start: -7, end: -7 },
            { start: 53, end: 73 },
          ],
          [10, Number.NaN, 30],
          [1, 2, 3],
        ),
      );
    },
  );

  function throwingGetter(target: object, field: string) {
    let reads = 0;
    Object.defineProperty(target, field, {
      enumerable: true,
      get() {
        reads++;
        throw new RangeError(marker);
      },
    });
    return () => reads;
  }

  describe.each(["envelope", "payload"])(
    "grid validation on the %s",
    (location) => {
      it.each([
        { id: "V22a", field: "interval" },
        { id: "V22b", field: "alignmentOffset" },
      ])(
        "$id rejects an unknown format without reading $field",
        ({ field }) => {
          const { c } = receiver();
          const before = observe(c);
          const payload = snapshotPayload();
          const input = { ...snapshotFixture(), segments: [payload] };
          const isEnvelope = location === "envelope";
          const target = isEnvelope ? input : payload;
          Object.defineProperty(target, "format", { value: 3 });
          const reads = throwingGetter(target, field);

          const { message } = thrown(() => c.hydrate(input));

          expect(message).toMatch(
            isEnvelope
              ? /^invalid snapshot: format must be 1 or 2\b/
              : /^invalid segment payload: format must be 1 or 2\b/,
          );
          expect(message).not.toContain(marker);
          expect(reads()).toBe(0);
          expect(observe(c)).toEqual(before);
        },
      );

      it("V22c rejects a mismatched interval without reading alignmentOffset", () => {
        const { c } = receiver();
        const payload = snapshotPayload();
        const input = { ...snapshotFixture(), segments: [payload] };
        const target = location === "envelope" ? input : payload;
        Object.assign(target, { interval: 11 });
        const reads = throwingGetter(target, "alignmentOffset");

        const { message } = thrown(() => c.hydrate(input));

        expect(message).toMatch(/\binterval\b/);
        expect(message).toMatch(/\bgot a finite number\b/);
        expect(reads()).toBe(0);
      });

      it("V22d applies a calendar snapshot without reading fixed-grid fields", () => {
        const input = dailySnapshot();
        const target = location === "envelope" ? input : input.segments[0];
        if (target === undefined)
          throw new Error("Missing calendar fixture segment");
        const intervalReads = throwingGetter(target, "interval");
        const offsetReads = throwingGetter(target, "alignmentOffset");
        const reader = calendarEngine(dailyUtc);
        const range = span(DAY);

        expect(hydrate(reader, input)).toEqual({ applied: [range] });
        expect(intervalReads()).toBe(0);
        expect(offsetReads()).toBe(0);
        expect(reader.get(ID, range)).toEqual({
          timestamps: new Float64Array([DAY]),
          fields: { value: new Float64Array([12]) },
          coverage: [range],
          misses: [],
        });
      });
    },
  );

  it("V22e rejects a calendar snapshot on a fixed grid without reading interval", () => {
    const input = dailySnapshot();
    const reads = throwingGetter(input, "interval");
    const reader = calendarEngine(10);

    const { message } = thrown(() => hydrate(reader, input));

    expect(message).toMatch(/format 2 names another kind of grid/);
    expect(reads()).toBe(0);
  });

  it("V23 reads calendar payload format once and rejects a mismatched startSlot", () => {
    const input = dailySnapshot();
    const payload = input.segments[0];
    if (payload === undefined || payload.format !== 2)
      throw new Error("Missing calendar fixture segment");
    payload.startSlot += 1;
    let reads = 0;
    Object.defineProperty(payload, "format", {
      enumerable: true,
      get: () => (reads++ === 0 ? 2 : 1),
    });
    const reader = calendarEngine(dailyUtc);

    const { message } = thrown(() => hydrate(reader, input));

    expect(message).toMatch(
      /^invalid segment payload: startSlot must be the slot of start\b/,
    );
    expect(reads).toBe(1);
    expect(reader.get(ID, span(DAY))).toMatchObject({
      timestamps: new Float64Array(),
      coverage: [],
    });
  });
});
