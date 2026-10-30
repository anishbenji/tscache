// A binary columnar body for series pages: what the mock backend answers
// when asked for COLUMNS_TYPE, and what the examples' fetcher asks for. It
// decodes as typed-array views over the one ArrayBuffer `fetch` returns,
// with no parsing per value and no copy, where a JSON page costs a parse of
// every number and a typed array built from each column
// (docs: the fetcher guide, "Binary pages").
//
// Layout, every number little-endian:
//
//   offset 0   4 bytes  magic: "TSC" and format version 1 (54 53 43 01)
//   offset 4   u32      H, the header's length in bytes
//   offset 8   H bytes  the header: UTF-8 JSON, a ColumnsHeader
//   then zero bytes up to the next multiple of 8
//   count × f64         the timestamps
//   per field, in the header's order, each from the next multiple of 8:
//   count × its dtype   the field's values
//
// The body ends with the last column. Every column starts on an 8-byte
// boundary, so each can be viewed in place (a Float64Array needs its byte
// offset to be a multiple of 8).
//
// The module imports only types, so it adds nothing to a fetcher bundle
// but itself.
// #region format
import type { Dtype } from "tscache";

/** The media type of a columns body, for Accept and Content-Type. */
export const COLUMNS_TYPE = "application/vnd.tscache.columns";

/** One field column: its name and how its values are stored. */
export interface ColumnSpec {
  name: string;
  dtype: Dtype;
}

/** The JSON header that precedes the columns. */
export interface ColumnsHeader {
  /** Points in the page: the length of every column. */
  count: number;
  /** The field columns, in the order they follow the timestamps. */
  fields: ColumnSpec[];
  /**
   * The answer's other members, as its JSON form carries them (the mock
   * backend's `meta` and `next`). Unchecked: the reader knows its backend.
   */
  [member: string]: unknown;
}

/** A typed array of numbers: what each dtype's column decodes to. */
export type NumericColumn =
  | Float64Array
  | Float32Array
  | Int32Array
  | Uint32Array
  | Int16Array
  | Uint16Array
  | Int8Array
  | Uint8Array;
// #endregion format

/** A body that is not a well-formed columns body. */
export class ColumnsError extends Error {
  override name = "ColumnsError";
}

const MAGIC = [0x54, 0x53, 0x43, 0x01];
/** Bytes before the header: the magic and the header's length. */
const PREAMBLE = 8;

type ColumnConstructor = {
  new (length: number): NumericColumn;
  new (buffer: ArrayBuffer, byteOffset: number, length: number): NumericColumn;
  readonly BYTES_PER_ELEMENT: number;
};

const COLUMN_TYPES: Readonly<Record<Dtype, ColumnConstructor>> = {
  f64: Float64Array,
  f32: Float32Array,
  i32: Int32Array,
  u32: Uint32Array,
  i16: Int16Array,
  u16: Uint16Array,
  i8: Int8Array,
  u8: Uint8Array,
};

/** The range of each integer dtype; floats take any number. */
const INTEGER_RANGES: Partial<Record<Dtype, readonly [number, number]>> = {
  i32: [-(2 ** 31), 2 ** 31 - 1],
  u32: [0, 2 ** 32 - 1],
  i16: [-(2 ** 15), 2 ** 15 - 1],
  u16: [0, 2 ** 16 - 1],
  i8: [-(2 ** 7), 2 ** 7 - 1],
  u8: [0, 2 ** 8 - 1],
};

/**
 * Typed arrays use the platform's byte order, and the format is
 * little-endian, as every browser's platform is.
 */
function requireLittleEndian(): void {
  if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) {
    throw new ColumnsError("columns bodies need a little-endian platform");
  }
}

function align8(offset: number): number {
  return Math.ceil(offset / 8) * 8;
}

// #region negotiate
/**
 * The media type of a Content-Type, or of one range of an Accept: what
 * precedes its parameters, trimmed and lowercased, as media types are
 * compared.
 */
function mediaTypeOf(value: string): string {
  return (value.split(";")[0] ?? "").trim().toLowerCase();
}

/**
 * A range's quality: its `q` parameter, 1 without one, or undefined when
 * the value is not a quality (0 to 1, at most three decimals).
 */
function qualityOf(range: string): number | undefined {
  for (const parameter of range.split(";").slice(1)) {
    const [name = "", value = ""] = parameter.split("=").map((s) => s.trim());
    if (name.toLowerCase() !== "q") continue;
    return /^(0(\.\d{0,3})?|1(\.0{0,3})?)$/.test(value)
      ? Number(value)
      : undefined;
  }
  return 1;
}

/** Ranges that match JSON, from the most specific. */
const JSON_RANGES = ["application/json", "application/*", "*/*"];

/**
 * Whether to answer a request with a columns body, from its Accept header.
 * Only a range that names COLUMNS_TYPE selects it, never a wildcard, so a
 * client that has not heard of the format keeps getting JSON. Its quality
 * must be above 0 and at least JSON's: the quality of the most specific
 * range that matches `application/json`, or 0 when none does.
 */
export function acceptsColumns(accept: string | null): boolean {
  let columns = 0;
  /** The most specific JSON range seen, as an index into JSON_RANGES. */
  let jsonRank = JSON_RANGES.length;
  let json = 0;
  for (const range of (accept ?? "").split(",")) {
    const type = mediaTypeOf(range);
    const quality = qualityOf(range);
    if (quality === undefined) continue;
    if (type === COLUMNS_TYPE) columns = Math.max(columns, quality);
    const rank = JSON_RANGES.indexOf(type);
    if (rank < 0 || rank > jsonRank) continue;
    json = rank < jsonRank ? quality : Math.max(json, quality);
    jsonRank = rank;
  }
  return columns > 0 && columns >= json;
}
// #endregion negotiate

/** What a backend encodes: one page, in the shape of its JSON form. */
export interface ColumnsInput {
  timestamps: ArrayLike<number>;
  /** Field name → values, one per timestamp. */
  fields: Readonly<Record<string, ArrayLike<number>>>;
  /** Field name → dtype, for every field in `fields`. */
  dtypes: Readonly<Record<string, Dtype>>;
}

/**
 * A page as a columns body. `members` go into the header beside `count`
 * and `fields` (JSON values: the page's meta, a next-page cursor). Throws
 * ColumnsError for a column whose length differs from the timestamps', or
 * a value its integer dtype cannot hold (NaN included: only float columns
 * carry NaN).
 */
export function encodeColumns(
  page: ColumnsInput,
  members: Readonly<Record<string, unknown>> = {},
): Uint8Array<ArrayBuffer> {
  requireLittleEndian();
  const count = page.timestamps.length;
  const fields: ColumnSpec[] = Object.keys(page.fields).map((name) => {
    const dtype = page.dtypes[name];
    if (dtype === undefined || !Object.hasOwn(COLUMN_TYPES, dtype)) {
      throw new ColumnsError(`field "${name}" has no dtype`);
    }
    return { name, dtype };
  });
  const header = new TextEncoder().encode(
    JSON.stringify({ ...members, count, fields }),
  );
  // Every column's offset, then the body's length.
  let end = align8(PREAMBLE + header.byteLength);
  const offsets = [end];
  end += count * 8;
  for (const { dtype } of fields) {
    end = align8(end);
    offsets.push(end);
    end += count * COLUMN_TYPES[dtype].BYTES_PER_ELEMENT;
  }
  const bytes = new Uint8Array(end);
  bytes.set(MAGIC);
  new DataView(bytes.buffer).setUint32(4, header.byteLength, true);
  bytes.set(header, PREAMBLE);
  new Float64Array(bytes.buffer, offsets[0], count).set(page.timestamps);
  fields.forEach(({ name, dtype }, i) => {
    const values = page.fields[name] as ArrayLike<number>;
    if (values.length !== count) {
      throw new ColumnsError(
        `field "${name}" has ${values.length} values for ${count} timestamps`,
      );
    }
    const range = INTEGER_RANGES[dtype];
    if (range !== undefined) {
      for (let j = 0; j < count; j++) {
        const value = values[j] as number;
        if (!Number.isInteger(value) || value < range[0] || value > range[1]) {
          throw new ColumnsError(
            `field "${name}" (${dtype}) cannot hold ${value} at index ${j}`,
          );
        }
      }
    }
    const Column = COLUMN_TYPES[dtype];
    new Column(bytes.buffer, offsets[i + 1] as number, count).set(values);
  });
  return bytes;
}

// #region decode
/** A decoded page: its header, and its columns as views over the body. */
export interface DecodedColumns {
  header: ColumnsHeader;
  timestamps: Float64Array;
  /** Field name → column, in the header's order. */
  fields: Record<string, NumericColumn>;
}

function isColumnSpec(value: unknown): value is ColumnSpec {
  if (typeof value !== "object" || value === null) return false;
  const { name, dtype } = value as Record<string, unknown>;
  return (
    typeof name === "string" &&
    name.length > 0 &&
    typeof dtype === "string" &&
    Object.hasOwn(COLUMN_TYPES, dtype)
  );
}

function parseHeader(bytes: Uint8Array): ColumnsHeader {
  let header: unknown;
  try {
    header = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    throw new ColumnsError("the columns header is not JSON");
  }
  if (typeof header !== "object" || header === null) {
    throw new ColumnsError("the columns header is not an object");
  }
  const { count, fields } = header as Record<string, unknown>;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    throw new ColumnsError(`the columns header has count ${String(count)}`);
  }
  if (!Array.isArray(fields) || !fields.every(isColumnSpec)) {
    throw new ColumnsError("the columns header's fields are not column specs");
  }
  if (new Set(fields.map((field) => field.name)).size !== fields.length) {
    throw new ColumnsError("the columns header names a field twice");
  }
  return header as ColumnsHeader;
}

/**
 * The columns of a body, as typed-array views over it. Pass what
 * `response.arrayBuffer()` returns: nothing is copied. A Uint8Array that
 * does not start on an 8-byte boundary of its buffer is copied once, since
 * its columns could not be viewed in place. Throws ColumnsError for a body
 * that is not one, truncated, or longer than its columns.
 */
export function decodeColumns(body: ArrayBuffer | Uint8Array): DecodedColumns {
  requireLittleEndian();
  const bytes =
    body instanceof Uint8Array
      ? body.byteOffset % 8 === 0
        ? body
        : body.slice()
      : new Uint8Array(body);
  const { buffer, byteOffset, byteLength } = bytes;
  if (byteLength < PREAMBLE || MAGIC.some((byte, i) => bytes[i] !== byte)) {
    throw new ColumnsError("not a columns body");
  }
  const headerLength = new DataView(buffer, byteOffset).getUint32(4, true);
  if (PREAMBLE + headerLength > byteLength) {
    throw new ColumnsError("the columns body ends inside its header");
  }
  const header = parseHeader(bytes.subarray(PREAMBLE, PREAMBLE + headerLength));
  const { count } = header;
  /** The next column of `Column`, viewed in place. */
  let at = align8(PREAMBLE + headerLength);
  const column = (Column: ColumnConstructor): NumericColumn => {
    const start = align8(at);
    at = start + count * Column.BYTES_PER_ELEMENT;
    if (at > byteLength) {
      throw new ColumnsError("the columns body ends inside a column");
    }
    return new Column(buffer as ArrayBuffer, byteOffset + start, count);
  };
  const timestamps = column(Float64Array) as Float64Array;
  // No prototype, so a field named `constructor` or `__proto__` is a key
  // like any other rather than an inherited member.
  const fields: Record<string, NumericColumn> = Object.create(null);
  for (const { name, dtype } of header.fields) {
    fields[name] = column(COLUMN_TYPES[dtype]);
  }
  if (at !== byteLength) {
    throw new ColumnsError(
      `the columns body has ${byteLength - at} bytes after its last column`,
    );
  }
  return { header, timestamps, fields };
}

/**
 * Whether a response's Content-Type is COLUMNS_TYPE, whatever its
 * parameters (`; charset=binary`) or case.
 */
export function isColumnsType(contentType: string | null): boolean {
  return contentType !== null && mediaTypeOf(contentType) === COLUMNS_TYPE;
}

/** The columns of a range fetched in several pages. */
export interface JoinedColumns {
  timestamps: Float64Array;
  fields: Record<string, NumericColumn>;
}

/**
 * The pages' columns joined, in page order: one page's views as they are,
 * else one new array per column. Throws ColumnsError when the pages'
 * columns differ in name, order or dtype: a value of one dtype written into
 * another's array would be converted silently (300 into a u8 is 44).
 */
export function joinColumns(pages: readonly DecodedColumns[]): JoinedColumns {
  const [first] = pages;
  if (first === undefined) throw new ColumnsError("no pages to join");
  const specs = (page: DecodedColumns) =>
    page.header.fields.map(({ name, dtype }) => `${name}:${dtype}`).join("\0");
  if (pages.some((page) => specs(page) !== specs(first))) {
    throw new ColumnsError("the pages' columns differ in name, order or dtype");
  }
  if (pages.length === 1) {
    return { timestamps: first.timestamps, fields: first.fields };
  }
  const join = (Column: ColumnConstructor, parts: NumericColumn[]) => {
    const joined = new Column(parts.reduce((n, part) => n + part.length, 0));
    let at = 0;
    for (const part of parts) {
      joined.set(part, at);
      at += part.length;
    }
    return joined;
  };
  // No prototype, as in decodeColumns.
  const fields: Record<string, NumericColumn> = Object.create(null);
  for (const { name, dtype } of first.header.fields) {
    const parts = pages.map((page) => page.fields[name] as NumericColumn);
    fields[name] = join(COLUMN_TYPES[dtype], parts);
  }
  const timestamps = join(
    Float64Array,
    pages.map((page) => page.timestamps),
  ) as Float64Array;
  return { timestamps, fields };
}
// #endregion decode
