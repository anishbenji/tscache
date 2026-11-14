import { describe, expect, it } from "vitest";
import type { Snapshot } from "../src/types";
import {
  all,
  fixture,
  requireCache,
  requirePage,
  state,
} from "./persist-test-helpers";

type Corrupt = {
  name: string;
  change: (records: ReturnType<typeof fixture>) => void;
};
const cacheCorruptions: Corrupt[] = [
  ...[null, 1, [], "record"].map((value) => ({
    name: `record ${JSON.stringify(value)}`,
    change: (r: ReturnType<typeof fixture>) => {
      r.cache = value as never;
    },
  })),
  ...[undefined, 0, 2, "1"].map((format) => ({
    name: `format ${String(format)}`,
    change: (r: ReturnType<typeof fixture>) => {
      Object.assign(requireCache(r), { format });
    },
  })),
  ...Object.entries({
    interval: 2,
    alignmentOffset: 1,
    fields: { value: "f32" },
    gapSplitK: 5,
    segmentSlotCap: 8,
    warnOnOverlapDiff: true,
  }).map(([key, value]) => ({
    name: `config ${key}`,
    change: (r: ReturnType<typeof fixture>) => {
      Object.assign(requireCache(r).config, { [key]: value });
    },
  })),
  ...[null, {}, [], undefined].map((config) => ({
    name: `config shape ${String(config)}`,
    change: (r: ReturnType<typeof fixture>) => {
      Object.assign(requireCache(r), { config });
    },
  })),
  ...["", null, 1, false].map((version) => ({
    name: `version ${String(version)}`,
    change: (r: ReturnType<typeof fixture>) => {
      Object.assign(requireCache(r), { version });
    },
  })),
  ...[null, "100", false, Number.NaN, Infinity, -Infinity, 2 ** 53].map(
    (finalizedUntil) => ({
      name: `watermark ${String(finalizedUntil)}`,
      change: (r: ReturnType<typeof fixture>) => {
        Object.assign(requireCache(r), { finalizedUntil });
      },
    }),
  ),
];
type SnapshotBad = { name: string; change: (s: Snapshot) => unknown };
const snapshots: SnapshotBad[] = [
  ...[null, 1, [], {}].map((value) => ({
    name: `snapshot shape ${JSON.stringify(value)}`,
    change: () => value,
  })),
  ...Object.entries({
    format: 2,
    interval: 2,
    alignmentOffset: 1,
    fields: {},
    range: { start: 1, end: 0 },
    version: "",
    finalizedUntil: 200,
    coverage: null,
    segments: null,
  }).map(([key, value]) => ({
    name: `snapshot ${key}`,
    change: (s: Snapshot) => ({ ...s, [key]: value }),
  })),
  ...[
    { start: 0.5, end: 3 },
    { start: 0, end: Number.NaN },
    { start: -1, end: 3 },
  ].map((range) => ({
    name: `range ${JSON.stringify(range)}`,
    change: (s: Snapshot) => ({ ...s, range }),
  })),
  ...[
    [{ start: -1, end: 0 }],
    [{ start: 0, end: 4 }],
    [{ start: 1, end: 0 }],
    [
      { start: 0, end: 1 },
      { start: 1, end: 2 },
    ],
    [
      { start: 0, end: 0 },
      { start: 1, end: 1 },
    ],
    [
      { start: 2, end: 2 },
      { start: 0, end: 0 },
    ],
    [{ start: 0.5, end: 1 }],
  ].map((coverage) => ({
    name: `coverage ${JSON.stringify(coverage)}`,
    change: (s: Snapshot) => ({ ...s, coverage }),
  })),
  ...[
    null,
    {},
    { format: 2 },
    { layout: "columnar" },
    { count: 0 },
    { start: 4 },
    { interval: 2 },
    { alignmentOffset: 1 },
    { mask: new Uint8Array() },
    { fields: [] },
  ].map((corruption) => ({
    name: `payload ${JSON.stringify(corruption)}`,
    change: (s: Snapshot) => ({
      ...s,
      segments: [
        corruption === null || Object.keys(corruption).length === 0
          ? corruption
          : { ...s.segments[0], ...corruption },
      ],
    }),
  })),
  {
    name: "overlapping payload extents",
    change: (s) => ({ ...s, segments: [s.segments[0], s.segments[0]] }),
  },
  {
    name: "descending payload extents",
    change: (s) => ({
      ...s,
      segments: [...s.segments].reverse().concat(s.segments),
    }),
  },
];

describe("untrusted restore records (§4.10.5 d)", () => {
  it.each([false, true])("absent cache record, orphan pages=%s", (orphans) => {
    const target = state();
    const records = fixture({}, [0]);
    expect(
      target.restore({ cache: undefined, pages: orphans ? records.pages : [] }),
    ).toEqual({ applied: [], rewrite: orphans });
    expect(target.coverage(all)).toEqual([]);
  });
  it.each(cacheCorruptions)(
    "invalid cache record: $name applies nothing",
    ({ change }) => {
      const records = fixture({}, [0, 4]);
      change(records);
      const target = state();
      expect(target.restore(records)).toEqual({ applied: [], rewrite: true });
      expect(target.get(all).timestamps).toEqual(new Float64Array());
      expect(target.coverage(all)).toEqual([]);
      expect(target.version).toBeUndefined();
      expect(target.finalizedUntil).toBeUndefined();
    },
  );
  it.each([
    {
      name: "foreign id",
      change: (p: ReturnType<typeof requirePage>) => ({
        ...p,
        cacheId: "foreign",
      }),
    },
    ...[0.5, Number.NaN, Infinity, 2 ** 53, "0"].map((page) => ({
      name: `page ${String(page)}`,
      change: (p: ReturnType<typeof requirePage>) => ({ ...p, page }),
    })),
    {
      name: "wrong page",
      change: (p: ReturnType<typeof requirePage>) => ({ ...p, page: 2 }),
    },
    {
      name: "page version",
      change: (p: ReturnType<typeof requirePage>) => ({
        ...p,
        snapshot: { ...p.snapshot, version: "other" },
      }),
    },
    ...snapshots.map(({ name, change }) => ({
      name,
      change: (p: ReturnType<typeof requirePage>) => ({
        ...p,
        snapshot: change(p.snapshot),
      }),
    })),
  ])("invalid page $name is skipped; the other page applies", ({ change }) => {
    const records = fixture({}, [0, 3, 4]);
    records.pages[0] = change(requirePage(records)) as never;
    const target = state();
    expect(target.restore(records)).toEqual({
      applied: [{ start: 4, end: 4 }],
      rewrite: true,
    });
    expect(target.get(all).timestamps).toEqual(new Float64Array([4]));
  });
  it("R4 page watermark cannot promote coverage or override cache watermark", () => {
    const records = fixture(
      { finalizedUntil: 200, segmentSlotCap: 256 },
      [150],
    );
    requireCache(records).finalizedUntil = 100;
    requirePage(records).snapshot.finalizedUntil = 200;
    const target = state({ segmentSlotCap: 256 });
    expect(target.restore(records)).toEqual({ applied: [], rewrite: true });
    expect(target.finalizedUntil).toBe(100);
    expect(target.coverage({ start: 150, end: 150 })).toEqual([]);
    expect(target.get(all).timestamps).toEqual(new Float64Array());
  });
});

describe("restore page order (§4.10.5 step 5)", () => {
  it.each([
    { name: "descending", order: [1, 0], applied: [{ start: 4, end: 4 }] },
    { name: "repeated", order: [0, 0, 1], applied: [{ start: 0, end: 4 }] },
  ])("a $name page is skipped and asks for a rewrite", ({ order, applied }) => {
    const records = fixture({}, [0, 3, 4]);
    const pages = order.map((i) => requirePage(records, i));
    const target = state();
    expect(target.restore({ cache: records.cache, pages })).toEqual({
      applied,
      rewrite: true,
    });
  });
});
