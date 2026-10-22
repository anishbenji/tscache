import { describe, expect, it } from "vitest";
import { decodeSnapshot, encodeSnapshot } from "../src/snapshot";
import type { EncodedSegmentPayload, EncodedSnapshot } from "../src/types";
import { batch, cache } from "./cache-test-helpers";
import { payloadField, snapshotFixture, thrown } from "./snapshot-test-helpers";

/** Hand-written base64 for price [1.5] and volume [-2], in little endian. */
function encodedFixture(): EncodedSnapshot {
  const segment: EncodedSegmentPayload = {
    format: 1,
    layout: "dense",
    start: 3,
    count: 1,
    interval: 10,
    alignmentOffset: 3,
    mask: "AQ==",
    fields: [
      { name: "price", dtype: "f64", data: "AAAAAAAA+D8=" },
      { name: "volume", dtype: "i16", data: "/v8=" },
    ],
  };
  return { ...snapshotFixture(), segments: [segment] };
}

describe("snapshot HTML encoding — architecture §2.8, §4.5(e), N38", () => {
  it("C01 encodes the specified base64 JSON shape and decodes an independent fixture without DOM", () => {
    const s = snapshotFixture();
    s.segments = [
      {
        format: 1,
        layout: "dense",
        start: 3,
        count: 1,
        interval: 10,
        alignmentOffset: 3,
        mask: new Uint8Array([1]),
        fields: [
          { name: "price", dtype: "f64", data: new Float64Array([1.5]).buffer },
          { name: "volume", dtype: "i16", data: new Int16Array([-2]).buffer },
        ],
      },
    ];
    expect(encodeSnapshot(s)).toEqual(encodedFixture());
    expect(JSON.parse(JSON.stringify(encodeSnapshot(s)))).toEqual(
      encodedFixture(),
    );
    expect(decodeSnapshot(encodedFixture())).toEqual(s);
    expect(decodeSnapshot(encodedFixture()).segments[0]?.mask).toBeInstanceOf(
      Uint8Array,
    );
    for (const f of decodeSnapshot(encodedFixture()).segments[0]?.fields ?? [])
      expect(f.data).toBeInstanceOf(ArrayBuffer);
  });

  it("C02 JSON round trip preserves NaN, all dtypes, metadata, gaps and the provisional tail (property e)", () => {
    const c = cache({
      fields: {
        double: "f64",
        single: "f32",
        signed: "i32",
        unsigned: "u32",
        short: "i16",
        ushort: "u16",
        byte: "i8",
        ubyte: "u8",
      },
      version: "v<1",
      finalizedUntil: 23.25,
    });
    c.put({
      timestamps: [3, 23, 33],
      fields: {
        double: [Number.NaN, -0, Infinity],
        single: [Number.NaN, 1.5, -Infinity],
        signed: [-2147483648, 0, 2147483647],
        unsigned: [0, 1, 4294967295],
        short: [-32768, 0, 32767],
        ushort: [0, 1, 65535],
        byte: [-128, 0, 127],
        ubyte: [0, 1, 255],
      },
    });
    const s = c.snapshot({ start: -7, end: 43 });
    const before = structuredClone(s);
    const encoded = encodeSnapshot(s);
    const decoded = decodeSnapshot(
      JSON.parse(JSON.stringify(encoded)) as EncodedSnapshot,
    );
    expect(decoded).toEqual(s);
    expect(s).toEqual(before);
    expect(decoded.coverage).toEqual([{ start: 3, end: 23 }]);
    const p = decoded.segments[0];
    if (!p) throw new Error("Missing decoded segment");
    expect(new Float64Array(payloadField(p, "double").data)[0]).toBeNaN();
    expect(new Float32Array(payloadField(p, "single").data)[0]).toBeNaN();
    expect(
      Object.is(new Float64Array(payloadField(p, "double").data)[2], -0),
    ).toBe(true);
  });

  it("C03 JSON round trips empty snapshots and confirmed gaps without inventing optional metadata", () => {
    const c = cache();
    for (const s of [
      c.snapshot({ start: 3, end: 3 }),
      (() => {
        c.put(batch([]), { range: { start: 3, end: 23 } });
        return c.snapshot({ start: -7, end: 43 });
      })(),
    ]) {
      const decoded = decodeSnapshot(
        JSON.parse(JSON.stringify(encodeSnapshot(s))) as EncodedSnapshot,
      );
      expect(decoded).toEqual(s);
      expect(decoded.segments).toEqual([]);
      expect(decoded).not.toHaveProperty("version");
      expect(decoded).not.toHaveProperty("finalizedUntil");
    }
  });

  it("C04 decoding checks no receiving cache's grid, schema or slot cap", () => {
    const c = cache({
      interval: 7,
      alignmentOffset: 2,
      fields: { temperature: "f32" },
      segmentSlotCap: 2,
    });
    c.put({
      timestamps: [2, 9, 16],
      fields: { temperature: [1, Number.NaN, 3] },
    });
    const s = c.snapshot({ start: -5, end: 23 });
    expect(
      decodeSnapshot(
        JSON.parse(JSON.stringify(encodeSnapshot(s))) as EncodedSnapshot,
      ),
    ).toEqual(s);
  });

  it.each([
    { name: "null", change: () => null },
    { name: "number", change: () => 1 },
    { name: "JSON text instead of JSON value", change: () => "{}" },
    { name: "array", change: () => [] },
    { name: "missing fields", change: () => ({}) },
    ...[
      "format",
      "interval",
      "alignmentOffset",
      "fields",
      "range",
      "coverage",
      "segments",
    ].map((key) => ({
      name: `missing ${key}`,
      change: (s: EncodedSnapshot) =>
        Object.fromEntries(Object.entries(s).filter(([name]) => name !== key)),
    })),
    ...Object.entries({
      format: "1",
      interval: "10",
      alignmentOffset: null,
      fields: [],
      range: {},
      coverage: null,
      version: 1,
      finalizedUntil: "63",
    }).map(([key, value]) => ({
      name: `wrong type for ${key}`,
      change: (s: EncodedSnapshot) => ({ ...s, [key]: value }),
    })),
    ...Object.entries({
      format: "1",
      layout: 1,
      start: "3",
      count: "1",
      interval: "10",
      alignmentOffset: null,
    }).map(([key, value]) => ({
      name: `wrong payload type for ${key}`,
      change: (s: EncodedSnapshot) => ({
        ...s,
        segments: [{ ...s.segments[0], [key]: value }],
      }),
    })),
    {
      name: "non-array segments",
      change: (s: EncodedSnapshot) => ({ ...s, segments: {} }),
    },
    {
      name: "null segment",
      change: (s: EncodedSnapshot) => ({ ...s, segments: [null] }),
    },
    {
      name: "non-string mask",
      change: (s: EncodedSnapshot) => ({
        ...s,
        segments: [{ ...s.segments[0], mask: [1] }],
      }),
    },
    {
      name: "missing payload fields",
      change: (s: EncodedSnapshot) => ({
        ...s,
        segments: [{ ...s.segments[0], fields: undefined }],
      }),
    },
    {
      name: "non-array payload fields",
      change: (s: EncodedSnapshot) => ({
        ...s,
        segments: [{ ...s.segments[0], fields: {} }],
      }),
    },
    {
      name: "null field entry",
      change: (s: EncodedSnapshot) => ({
        ...s,
        segments: [{ ...s.segments[0], fields: [null] }],
      }),
    },
    {
      name: "missing field name",
      change: (s: EncodedSnapshot) => ({
        ...s,
        segments: [
          {
            ...s.segments[0],
            fields: [{ dtype: "f64", data: "AAAAAAAA+D8=" }],
          },
        ],
      }),
    },
    {
      name: "missing field dtype",
      change: (s: EncodedSnapshot) => ({
        ...s,
        segments: [
          {
            ...s.segments[0],
            fields: [{ name: "price", data: "AAAAAAAA+D8=" }],
          },
        ],
      }),
    },
    {
      name: "non-string field data",
      change: (s: EncodedSnapshot) => ({
        ...s,
        segments: [
          {
            ...s.segments[0],
            fields: [{ name: "price", dtype: "f64", data: new ArrayBuffer(8) }],
          },
        ],
      }),
    },
  ])("C05 rejects malformed encoded shape: $name", ({ change }) => {
    expect(
      thrown(() => decodeSnapshot(change(encodedFixture()) as EncodedSnapshot))
        .message.length,
    ).toBeGreaterThan(0);
  });

  it.each(["!", "A", "AA=A", "====", "AQ==!"])(
    "C06 rejects malformed mask or field base64 %s with TscacheError",
    (data) => {
      for (const target of ["mask", "field"]) {
        const s = encodedFixture();
        const p = s.segments[0];
        if (!p) throw new Error("Missing encoded fixture segment");
        if (target === "mask") p.mask = data;
        else {
          const f = p.fields[0];
          if (!f) throw new Error("Missing encoded fixture field");
          f.data = data;
        }
        const before = structuredClone(s);
        expect(thrown(() => decodeSnapshot(s)).message.length).toBeGreaterThan(
          0,
        );
        expect(s).toEqual(before);
      }
    },
  );
});
