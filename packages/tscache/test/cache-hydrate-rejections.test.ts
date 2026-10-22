import { describe, expect, it, vi } from "vitest";
import { CacheState } from "../src/engine/cache";
import { resolveCacheConfig } from "../src/engine/validate";
import { segmentFromPayload } from "../src/segment/payload";
import type { DenseSegmentPayload, Snapshot } from "../src/types";
import { batch, malformedRanges, observe } from "./cache-test-helpers";
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
        grid: c.config,
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
