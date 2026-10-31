import type { Dtype } from "tscache";
import { describe, expect, it } from "vitest";
import {
  acceptsColumns,
  COLUMNS_TYPE,
  ColumnsError,
  type ColumnsInput,
  decodeColumns,
  encodeColumns,
  fromColumns,
  fromJson,
  isColumnsType,
  joinPages,
  type NormalPage,
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

  it("decodes a Node Buffer at an unaligned offset of its pool (R2-2)", () => {
    // A Buffer's slice() shares memory, so a copy must be made explicitly.
    const bytes = encodeColumns(
      input({ close: ["f64", [1.5, 2.5]], volume: ["u16", [3, 4]] }),
    );
    for (const offset of [1, 3, 5, 7]) {
      const pool = Buffer.alloc(bytes.byteLength + offset);
      pool.set(bytes, offset);
      const decoded = decodeColumns(pool.subarray(offset));
      expect([...decoded.timestamps]).toEqual([T0, T0 + MINUTE]);
      expect([...(decoded.fields.close ?? [])]).toEqual([1.5, 2.5]);
      expect([...(decoded.fields.volume ?? [])]).toEqual([3, 4]);
      // The copy is the decoder's own, not a view of the caller's pool.
      expect(decoded.timestamps.buffer).not.toBe(pool.buffer);
    }
    // An aligned Buffer is viewed in place.
    const aligned = Buffer.alloc(bytes.byteLength + 8);
    aligned.set(bytes, 8);
    const view = aligned.subarray(8);
    expect(decodeColumns(view).timestamps.buffer).toBe(view.buffer);
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

/** A value each dtype holds exactly, other than the JSON page's. */
const EXACT: Record<Dtype, number> = {
  f64: 0.1,
  f32: Math.fround(1.1),
  i32: -2_000_000_000,
  u32: 4_000_000_000,
  i16: -30_000,
  u16: 60_000,
  i8: -100,
  u8: 200,
};
/** A JSON value no integer dtype above holds: widening must keep it. */
const JSON_VALUE = 70_000.25;

/** A one-point page of these columns, through a columns body. */
function binaryPage(
  schema: readonly (readonly [string, Dtype, number])[],
  t: number,
): NormalPage {
  return fromColumns(
    decodeColumns(
      body(
        encodeColumns({
          timestamps: [T0 + t * MINUTE],
          fields: Object.fromEntries(schema.map(([name, , v]) => [name, [v]])),
          dtypes: Object.fromEntries(
            schema.map(([name, dtype]) => [name, dtype]),
          ),
        }),
      ),
    ),
  );
}

/** The same page shape as JSON delivers it, parsed from text. */
function jsonPage(
  schema: readonly (readonly [string, number])[],
  t: number,
): NormalPage {
  const fields = `{${schema.map(([name, v]) => `${JSON.stringify(name)}:[${v}]`).join(",")}}`;
  return fromJson(
    JSON.parse(`{"timestamps":[${T0 + t * MINUTE}],"fields":${fields}}`),
  );
}

describe("joinPages", () => {
  it("returns a single page's columns as they are", () => {
    const decoded = decodeColumns(
      body(encodeColumns(input({ close: ["f64", [1, 2]] }))),
    );
    const joined = joinPages([fromColumns(decoded)]);
    expect(joined.timestamps).toBe(decoded.timestamps);
    expect(joined.fields.close).toBe(decoded.fields.close);
    const json = jsonPage([["close", 3]], 0);
    expect(joinPages([json]).fields.close).toEqual([3]);
  });

  it("joins one dtype throughout as that dtype", () => {
    for (const [dtype, value] of Object.entries(EXACT) as [Dtype, number][]) {
      const joined = joinPages([
        binaryPage([["x", dtype, value]], 0),
        binaryPage([["x", dtype, value]], 1),
      ]);
      const kind = decodeColumns(
        body(encodeColumns(input({ x: [dtype, [value]] }))),
      ).fields.x?.constructor;
      expect(joined.fields.x?.constructor, dtype).toBe(kind);
      expect([...(joined.fields.x ?? [])]).toEqual([value, value]);
      expect(joined.timestamps).toBeInstanceOf(Float64Array);
    }
  });

  it("joins JSON numbers throughout as numbers", () => {
    const joined = joinPages([
      jsonPage([["x", 1.5]], 0),
      jsonPage([["x", 2]], 1),
    ]);
    expect(joined.fields.x).toEqual([1.5, 2]);
    expect(Array.isArray(joined.timestamps)).toBe(true);
  });

  it("widens a binary and a JSON page to float64, in either order, for every dtype (R3-1)", () => {
    for (const [dtype, value] of Object.entries(EXACT) as [Dtype, number][]) {
      const binary = binaryPage([["x", dtype, value]], 0);
      const json = jsonPage([["x", JSON_VALUE]], 1);
      for (const [order, pages, expected] of [
        ["binary, JSON", [binary, json], [value, JSON_VALUE]],
        ["JSON, binary", [json, binary], [JSON_VALUE, value]],
      ] as const) {
        const joined = joinPages(pages);
        expect(joined.fields.x, `${dtype} ${order}`).toBeInstanceOf(
          Float64Array,
        );
        expect([...(joined.fields.x ?? [])], `${dtype} ${order}`).toEqual(
          expected,
        );
        expect(joined.timestamps).toBeInstanceOf(Float64Array);
      }
    }
  });

  it("widens two binary dtypes to float64 rather than narrow (R1-1)", () => {
    // Joined into the first page's u8 array, the u16 300 would read as 44.
    const joined = joinPages([
      binaryPage([["volume", "u8", 1]], 0),
      binaryPage([["volume", "u16", 300]], 1),
    ]);
    expect(joined.fields.volume).toBeInstanceOf(Float64Array);
    expect([...(joined.fields.volume ?? [])]).toEqual([1, 300]);
    // Every pair of dtypes, each value kept exactly.
    for (const [a, va] of Object.entries(EXACT) as [Dtype, number][]) {
      for (const [b, vb] of Object.entries(EXACT) as [Dtype, number][]) {
        if (a === b) continue;
        const pair = joinPages([
          binaryPage([["x", a, va]], 0),
          binaryPage([["x", b, vb]], 1),
        ]);
        expect([...(pair.fields.x ?? [])], `${a} + ${b}`).toEqual([va, vb]);
      }
    }
  });

  it("refuses a JSON column that holds anything but numbers", () => {
    // JSON.stringify writes NaN as null; set() would store it as 0.
    for (const text of [
      '{"timestamps":[1],"fields":{"x":[null]}}',
      '{"timestamps":[1],"fields":{"x":["1"]}}',
      '{"timestamps":[1],"fields":{"x":1}}',
      '{"timestamps":[null],"fields":{}}',
      '{"timestamps":[1]}',
      '{"fields":{}}',
      "[]",
    ]) {
      expect(() => fromJson(JSON.parse(text)), text).toThrow(ColumnsError);
    }
  });

  it("refuses a JSON page whose column length differs from its timestamps, before any join (R4-1)", () => {
    // Joined, a long page and a short one cancel out: [0, 60000, 120000]
    // against [10, 20, 30] would store 20 at 60000.
    const long = '{"timestamps":[0],"fields":{"v":[10,20]}}';
    const short = '{"timestamps":[120000],"fields":{"v":[]}}';
    for (const text of [long, short]) {
      expect(() => fromJson(JSON.parse(text)), text).toThrow(
        /has \d+ values for 1 timestamps/,
      );
    }
    expect(() =>
      joinPages([
        fromJson(JSON.parse(long)),
        binaryPage([["v", "f64", 30]], 1),
        fromJson(JSON.parse(short)),
      ]),
    ).toThrow(ColumnsError);
  });

  it("refuses pages whose columns differ in name or order", () => {
    const ab = binaryPage(
      [
        ["a", "f64", 1],
        ["b", "f64", 1],
      ],
      0,
    );
    for (const other of [
      binaryPage([["a", "f64", 1]], 1),
      binaryPage(
        [
          ["b", "f64", 1],
          ["a", "f64", 1],
        ],
        1,
      ),
      jsonPage(
        [
          ["b", 1],
          ["a", 1],
        ],
        1,
      ),
      jsonPage(
        [
          ["a", 1],
          ["c", 1],
        ],
        1,
      ),
      jsonPage(
        [
          ["a", 1],
          ["b", 1],
          ["c", 1],
        ],
        1,
      ),
    ]) {
      expect(() => joinPages([ab, other])).toThrow(/columns differ/);
    }
  });

  it("refuses no pages at all", () => {
    expect(() => joinPages([])).toThrow(ColumnsError);
  });

  it("refuses names built to collide with a delimited signature (R2-1)", () => {
    // Joined as `name:dtype` with NUL between columns, both schemas read
    // "a:u8\0a:u8\0a:u16"; a u16 300 then narrowed to the u8 44.
    const odd = "a:u8\u0000a";
    const first = binaryPage(
      [
        ["a", "u8", 1],
        [odd, "u16", 2],
      ],
      0,
    );
    const second = binaryPage(
      [
        [odd, "u8", 3],
        ["a", "u16", 300],
      ],
      1,
    );
    expect(() => joinPages([first, second])).toThrow(ColumnsError);
    // As JSON, the same names, so the same refusal.
    const json = jsonPage(
      [
        [odd, 3],
        ["a", 300],
      ],
      1,
    );
    expect(() => joinPages([first, json])).toThrow(ColumnsError);
  });

  it("joins exactly what its pages hold, or refuses them, whatever the names, dtypes and formats (property)", () => {
    type Schema = [string, Dtype][];
    // Names from characters that delimit, quote or escape in a signature
    // or in the JSON header; schemas of one to three columns.
    const alphabet = [
      "a",
      ":",
      "\u0000",
      '"',
      "\\",
      ",",
      "{",
      "}",
      "u8",
      "f64",
    ];
    const dtypes = Object.keys(EXACT) as Dtype[];
    // mulberry32, seeded: the same 2,000 cases on every run.
    let seed = 42;
    const random = (n: number) => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 2 ** 32) * n);
    };
    const name = () =>
      Array.from(
        { length: 1 + random(4) },
        () => alphabet[random(alphabet.length)],
      ).join("");
    const schema = (): Schema => {
      const columns: Schema = [];
      for (let i = random(3) + 1; i > 0; i--) {
        const column = name();
        if (!columns.some(([taken]) => taken === column)) {
          columns.push([column, dtypes[random(dtypes.length)] as Dtype]);
        }
      }
      return columns;
    };
    /** A schema one change away from `of`: a dtype, the order, a column. */
    const near = (of: Schema): Schema => {
      const next = of.map(([n, d]): [string, Dtype] => [n, d]);
      const column = next[random(next.length)] as [string, Dtype];
      switch (random(3)) {
        case 0:
          column[1] = dtypes[(dtypes.indexOf(column[1]) + 1) % 8] as Dtype;
          return next;
        case 1:
          return next.reverse();
        default:
          return next.length > 1 ? next.slice(1) : [...next, ["zz", "u8"]];
      }
    };
    /**
     * R2-1's construction from `of` (given a second column if it has one
     * only): a schema whose first name runs the first two columns together
     * as a `name:dtype` signature joined with NUL writes them.
     */
    const collision = (of: Schema): [Schema, Schema] => {
      const a: Schema = of.length > 1 ? of : [...of, [`${of[0]?.[0]}b`, "u16"]];
      const [[n1, d1], [n2, d2], ...rest] = a as [
        [string, Dtype],
        [string, Dtype],
        ...Schema,
      ];
      return [a, [[`${n1}:${d1}\u0000${n2}`, d2], ...rest]];
    };
    /** The page of `columns`, as a columns body or as JSON. */
    const pageOf = (columns: Schema, t: number, json: boolean) =>
      json
        ? jsonPage(
            columns.map(([n]) => [n, JSON_VALUE]),
            t,
          )
        : binaryPage(
            columns.map(([n, d]) => [n, d, EXACT[d]]),
            t,
          );
    const sameNames = (a: Schema, b: Schema) =>
      a.length === b.length && a.every(([n], i) => n === b[i]?.[0]);
    const counts = { refused: 0, collisions: 0, joined: 0, mixed: 0 };
    for (let run = 0; run < 2000; run++) {
      const kind = random(4);
      const a = schema();
      const [first, second] =
        kind === 0
          ? [a, schema()]
          : kind === 1
            ? collision(a)
            : [a, kind === 2 ? a : near(a)];
      const formats = [random(2) === 1, random(2) === 1] as const;
      const pages = [
        pageOf(first, 0, formats[0]),
        pageOf(second, 1, formats[1]),
      ];
      const what = JSON.stringify([first, second, formats]);
      if (!sameNames(first, second)) {
        expect(() => joinPages(pages), what).toThrow(ColumnsError);
        counts.refused++;
        if (kind === 1) counts.collisions++;
        continue;
      }
      // Same names: joined, every value exactly as its page holds it, in
      // the type the rule table gives.
      const joined = joinPages(pages);
      counts.joined++;
      first.forEach(([column, dtype], i) => {
        const other = second[i]?.[1] as Dtype;
        const values = [
          formats[0] ? JSON_VALUE : EXACT[dtype],
          formats[1] ? JSON_VALUE : EXACT[other],
        ];
        const got = joined.fields[column];
        expect([...(got ?? [])], what).toEqual(values);
        if (formats[0] && formats[1])
          expect(Array.isArray(got), what).toBe(true);
        else if (!formats[0] && !formats[1] && dtype === other) {
          expect(got?.constructor, what).toBe(
            pages[0]?.fields[i]?.values.constructor,
          );
        } else {
          expect(got, what).toBeInstanceOf(Float64Array);
          counts.mixed++;
        }
      });
    }
    // Every outcome was exercised, not one of them only.
    expect(counts.refused).toBeGreaterThan(800);
    expect(counts.collisions).toBeGreaterThan(300);
    expect(counts.joined).toBeGreaterThan(300);
    expect(counts.mixed).toBeGreaterThan(300);
  });
});
