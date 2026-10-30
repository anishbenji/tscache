import type { Dtype } from "tscache";
import { describe, expect, it } from "vitest";
import {
  acceptsColumns,
  COLUMNS_TYPE,
  ColumnsError,
  type ColumnsInput,
  decodeColumns,
  encodeColumns,
  isColumnsType,
  joinColumns,
} from "../src/columns";

const T0 = Date.UTC(2026, 5, 1);
const MINUTE = 60_000;

const DTYPES: Record<Dtype, number[]> = {
  f64: [1.5, -2.25, 1e300],
  f32: [1.5, -2.25, 3.0517578125e-5],
  i32: [-2_147_483_648, 0, 2_147_483_647],
  u32: [0, 1, 4_294_967_295],
  i16: [-32_768, 0, 32_767],
  u16: [0, 1, 65_535],
  i8: [-128, 0, 127],
  u8: [0, 1, 255],
};

function input(fields: Record<string, [Dtype, number[]]>): ColumnsInput {
  const count = Object.values(fields)[0]?.[1].length ?? 0;
  return {
    timestamps: Array.from({ length: count }, (_, i) => T0 + i * MINUTE),
    fields: Object.fromEntries(
      Object.entries(fields).map(([name, [, values]]) => [name, values]),
    ),
    dtypes: Object.fromEntries(
      Object.entries(fields).map(([name, [dtype]]) => [name, dtype]),
    ),
  };
}

/** The body as fetch hands it over: a fresh ArrayBuffer of its own. */
function body(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

describe("columns format", () => {
  it("names a media type of its own", () => {
    expect(COLUMNS_TYPE).toBe("application/vnd.tscache.columns");
  });

  it("round-trips every dtype, in the dtype's typed array", () => {
    const fields = Object.fromEntries(
      Object.entries(DTYPES).map(([dtype, values]) => [
        `${dtype}-field`,
        [dtype as Dtype, values] as [Dtype, number[]],
      ]),
    );
    const decoded = decodeColumns(body(encodeColumns(input(fields))));
    expect(decoded.timestamps).toBeInstanceOf(Float64Array);
    expect([...decoded.timestamps]).toEqual([T0, T0 + MINUTE, T0 + 2 * MINUTE]);
    expect(decoded.header.fields).toEqual(
      Object.keys(DTYPES).map((dtype) => ({ name: `${dtype}-field`, dtype })),
    );
    const kinds: Record<Dtype, string> = {
      f64: "Float64Array",
      f32: "Float32Array",
      i32: "Int32Array",
      u32: "Uint32Array",
      i16: "Int16Array",
      u16: "Uint16Array",
      i8: "Int8Array",
      u8: "Uint8Array",
    };
    for (const [dtype, values] of Object.entries(DTYPES)) {
      const column = decoded.fields[`${dtype}-field`];
      expect(column?.constructor.name).toBe(kinds[dtype as Dtype]);
      expect([...(column ?? [])]).toEqual(values);
    }
  });

  it("keeps the answer's other members in the header", () => {
    const meta = { version: "v3", finalizedUntil: T0 + MINUTE };
    const bytes = encodeColumns(input({ close: ["f64", [1, 2]] }), {
      meta,
      next: T0 + 2 * MINUTE,
    });
    const { header } = decodeColumns(body(bytes));
    expect(header.count).toBe(2);
    expect(header.meta).toEqual(meta);
    expect(header.next).toBe(T0 + 2 * MINUTE);
  });

  it("carries NaN through float columns", () => {
    const decoded = decodeColumns(
      body(
        encodeColumns(
          input({
            open: ["f64", [Number.NaN, 1]],
            cpu: ["f32", [2, Number.NaN]],
          }),
        ),
      ),
    );
    expect(Number.isNaN(decoded.fields.open?.[0])).toBe(true);
    expect(decoded.fields.open?.[1]).toBe(1);
    expect(decoded.fields.cpu?.[0]).toBe(2);
    expect(Number.isNaN(decoded.fields.cpu?.[1])).toBe(true);
  });

  it("refuses a value an integer column cannot hold", () => {
    for (const value of [Number.NaN, 1.5, 256, -1]) {
      expect(() =>
        encodeColumns(input({ battery: ["u8", [1, value]] })),
      ).toThrow(ColumnsError);
    }
  });

  it("refuses a column whose length differs from the timestamps", () => {
    const good = input({ close: ["f64", [1, 2]] });
    const bad = { ...good, fields: { close: [1] } };
    expect(() => encodeColumns(bad)).toThrow(ColumnsError);
  });

  it("encodes an empty page, and decodes it to empty columns", () => {
    const empty = input({ close: ["f64", []], volume: ["u32", []] });
    const decoded = decodeColumns(body(encodeColumns(empty, { next: 7 })));
    expect(decoded.header.count).toBe(0);
    expect(decoded.timestamps).toHaveLength(0);
    expect(decoded.fields.close).toEqual(new Float64Array(0));
    expect(decoded.fields.volume).toEqual(new Uint32Array(0));
    expect(decoded.header.next).toBe(7);
  });

  it("decodes a page with no fields: timestamps only", () => {
    const decoded = decodeColumns(
      body(encodeColumns({ timestamps: [T0], fields: {}, dtypes: {} })),
    );
    expect([...decoded.timestamps]).toEqual([T0]);
    expect(Object.keys(decoded.fields)).toEqual([]);
  });

  it("aligns every column for its view, whatever the header's length", () => {
    // Field names of 1 to 9 characters move the header's length through
    // every remainder mod 8; odd counts leave the narrow columns unaligned
    // unless each column is padded.
    for (let length = 1; length <= 9; length++) {
      for (const count of [1, 3]) {
        const values = Array.from({ length: count }, (_, i) => i);
        const decoded = decodeColumns(
          body(
            encodeColumns(
              input({
                ["n".repeat(length)]: ["u8", values],
                a: ["f32", values],
                b: ["i16", values],
                c: ["f64", values],
              }),
            ),
          ),
        );
        const views = [decoded.timestamps, ...Object.values(decoded.fields)];
        for (const view of views) {
          expect(view.byteOffset % 8).toBe(0);
          expect([...view]).toEqual(
            view === decoded.timestamps
              ? values.map((i) => T0 + i * MINUTE)
              : values,
          );
        }
      }
    }
  });

  it("decodes views over the body, copying nothing", () => {
    const buffer = body(
      encodeColumns(input({ close: ["f64", [1, 2]], volume: ["u32", [3, 4]] })),
    );
    const decoded = decodeColumns(buffer);
    expect(decoded.timestamps.buffer).toBe(buffer);
    expect(decoded.fields.close?.buffer).toBe(buffer);
    expect(decoded.fields.volume?.buffer).toBe(buffer);
  });

  it("decodes a body held in a view at an offset of a larger buffer", () => {
    const bytes = encodeColumns(input({ close: ["f64", [1, 2]] }));
    const larger = new Uint8Array(bytes.byteLength + 3);
    larger.set(bytes, 3);
    const decoded = decodeColumns(larger.subarray(3));
    expect([...(decoded.fields.close ?? [])]).toEqual([1, 2]);
  });

  it("keeps fields whose names Object.prototype also has", () => {
    const decoded = decodeColumns(
      body(
        encodeColumns(
          input(
            // Entries, so __proto__ becomes an own key, not the prototype.
            Object.fromEntries<[Dtype, number[]]>([
              ["constructor", ["f64", [1]]],
              ["__proto__", ["u8", [2]]],
            ]),
          ),
        ),
      ),
    );
    expect(Object.entries(decoded.fields).map(([k, v]) => [k, [...v]])).toEqual(
      [
        ["constructor", [1]],
        ["__proto__", [2]],
      ],
    );
  });

  it("rejects every truncation of a body cleanly", () => {
    const bytes = encodeColumns(
      input({ close: ["f64", [1, 2, 3]], volume: ["u16", [4, 5, 6]] }),
      { meta: { version: "v1" } },
    );
    for (let length = 0; length < bytes.byteLength; length++) {
      expect(() => decodeColumns(body(bytes.subarray(0, length)))).toThrow(
        ColumnsError,
      );
    }
  });

  it("rejects bytes after the last column", () => {
    const bytes = encodeColumns(input({ close: ["f64", [1]] }));
    const longer = new Uint8Array(bytes.byteLength + 8);
    longer.set(bytes);
    expect(() => decodeColumns(body(longer))).toThrow(ColumnsError);
  });

  it("rejects a body that is not this format", () => {
    const json = new TextEncoder().encode('{"timestamps":[],"fields":{}}');
    expect(() => decodeColumns(body(json))).toThrow(/not a columns body/);
  });

  /** A body with this header text and room for its columns. */
  function withHeader(text: string, columnBytes = 64): ArrayBuffer {
    const header = new TextEncoder().encode(text);
    const start = Math.ceil((8 + header.byteLength) / 8) * 8;
    const bytes = new Uint8Array(start + columnBytes);
    bytes.set([0x54, 0x53, 0x43, 0x01]);
    new DataView(bytes.buffer).setUint32(4, header.byteLength, true);
    bytes.set(header, 8);
    return bytes.buffer;
  }

  it("accepts a hand-built body, as the format is documented", () => {
    const decoded = decodeColumns(
      withHeader('{"count":1,"fields":[{"name":"x","dtype":"u8"}]}', 9),
    );
    expect(decoded.header.count).toBe(1);
    expect(decoded.fields.x).toHaveLength(1);
  });

  it("rejects a header that does not describe columns", () => {
    const headers = [
      "not json",
      "[]",
      '{"fields":[]}',
      '{"count":-1,"fields":[]}',
      '{"count":1.5,"fields":[]}',
      '{"count":1}',
      '{"count":1,"fields":[{"name":"x","dtype":"f16"}]}',
      '{"count":1,"fields":[{"name":"","dtype":"f64"}]}',
      '{"count":1,"fields":[{"dtype":"f64"}]}',
      '{"count":1,"fields":[{"name":"x","dtype":"f64"},{"name":"x","dtype":"u8"}]}',
    ];
    for (const text of headers) {
      expect(() => decodeColumns(withHeader(text)), text).toThrow(ColumnsError);
    }
  });

  it("rejects a header length past the end of the body", () => {
    const bytes = new Uint8Array(16);
    bytes.set([0x54, 0x53, 0x43, 0x01]);
    new DataView(bytes.buffer).setUint32(4, 1_000, true);
    expect(() => decodeColumns(bytes.buffer)).toThrow(ColumnsError);
  });
});

describe("isColumnsType", () => {
  it("matches the media type whatever its parameters, case or spacing", () => {
    for (const value of [
      COLUMNS_TYPE,
      `${COLUMNS_TYPE}; charset=binary`,
      `${COLUMNS_TYPE};v=1`,
      "Application/VND.TSCache.Columns",
      `  ${COLUMNS_TYPE}  ; x=y`,
    ]) {
      expect(isColumnsType(value), value).toBe(true);
    }
  });

  it("matches nothing else", () => {
    for (const value of [
      null,
      "",
      "application/json",
      "application/json; charset=utf-8",
      `${COLUMNS_TYPE}2`,
      `x-${COLUMNS_TYPE}`,
      "application/octet-stream",
    ]) {
      expect(isColumnsType(value), String(value)).toBe(false);
    }
  });
});

describe("acceptsColumns", () => {
  it("chooses columns only when the Accept names them and does not prefer JSON", () => {
    const cases: [string | null, boolean][] = [
      [COLUMNS_TYPE, true],
      [`${COLUMNS_TYPE}, application/json;q=0.5`, true],
      [`application/json;q=0.5, ${COLUMNS_TYPE}`, true],
      [`APPLICATION/VND.TSCACHE.COLUMNS`, true],
      [`${COLUMNS_TYPE} ; q=0.8 , application/json;q=0.5`, true],
      [`${COLUMNS_TYPE}, */*`, true],
      [`${COLUMNS_TYPE};Q=0.9, application/*;q=0.2`, true],
      // Refused outright, or ranked below JSON.
      [`${COLUMNS_TYPE};q=0, application/json`, false],
      [`${COLUMNS_TYPE};q=0`, false],
      [`application/json, ${COLUMNS_TYPE};q=0.1`, false],
      [`${COLUMNS_TYPE};q=0.4, */*;q=0.5`, false],
      // Not named: wildcards and other types get JSON.
      [null, false],
      ["", false],
      ["*/*", false],
      ["application/*", false],
      ["application/json", false],
      [`${COLUMNS_TYPE}2`, false],
      // A quality that is not one is not a preference.
      [`${COLUMNS_TYPE};q=2`, false],
      [`${COLUMNS_TYPE};q=abc`, false],
    ];
    for (const [accept, columns] of cases) {
      expect(acceptsColumns(accept), String(accept)).toBe(columns);
    }
  });
});

describe("joinColumns", () => {
  const page = (dtypes: Record<string, Dtype>, start: number, n: number) => {
    const timestamps = Array.from(
      { length: n },
      (_, i) => T0 + (start + i) * MINUTE,
    );
    const fields = Object.fromEntries(
      Object.keys(dtypes).map((name) => [
        name,
        timestamps.map((_, i) => (start + i) * 100),
      ]),
    );
    return decodeColumns(body(encodeColumns({ timestamps, fields, dtypes })));
  };

  it("returns a single page's views as they are", () => {
    const only = page({ close: "f64" }, 0, 3);
    const joined = joinColumns([only]);
    expect(joined.timestamps).toBe(only.timestamps);
    expect(joined.fields.close).toBe(only.fields.close);
  });

  it("joins pages into one array of each column's dtype", () => {
    const dtypes: Record<string, Dtype> = { close: "f64", volume: "u16" };
    const joined = joinColumns([page(dtypes, 0, 2), page(dtypes, 2, 3)]);
    expect([...joined.timestamps]).toEqual(
      [0, 1, 2, 3, 4].map((i) => T0 + i * MINUTE),
    );
    expect(joined.fields.volume).toBeInstanceOf(Uint16Array);
    expect([...(joined.fields.volume ?? [])]).toEqual([0, 100, 200, 300, 400]);
    expect([...(joined.fields.close ?? [])]).toEqual([0, 100, 200, 300, 400]);
  });

  it("refuses pages whose columns differ in dtype, rather than convert", () => {
    // A u16 value written into the first page's u8 array would wrap: 300
    // becomes 44.
    const pages = [page({ volume: "u8" }, 0, 1), page({ volume: "u16" }, 3, 1)];
    expect(() => joinColumns(pages)).toThrow(ColumnsError);
    expect(() => joinColumns(pages)).toThrow(/columns differ/);
  });

  it("refuses pages whose columns differ in name or order", () => {
    const ab = page({ a: "f64", b: "f64" }, 0, 1);
    for (const other of [
      page({ a: "f64" }, 1, 1),
      page({ b: "f64", a: "f64" }, 1, 1),
      page({ a: "f64", c: "f64" }, 1, 1),
      page({ a: "f64", b: "f64", c: "f64" }, 1, 1),
    ]) {
      expect(() => joinColumns([ab, other])).toThrow(ColumnsError);
    }
  });

  it("refuses no pages at all", () => {
    expect(() => joinColumns([])).toThrow(ColumnsError);
  });
});
