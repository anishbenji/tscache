// Server rendering through tscache's public API, the same in every
// framework. The server reads a range with its own client and writes the
// answer into the page. The browser renders that answer first, so its
// hydration render matches the server's, and puts the answer's covered
// ranges into its own cache with those ranges, so it fetches only the rest
// (a provisional tail, say).

import type {
  CacheConfig,
  CacheHandle,
  Dtype,
  FieldArray,
  GetResult,
  Miss,
  Range,
} from "tscache";

/** What a server read: the range it asked for and the cache's answer. */
export interface ServerRead {
  range: Range;
  result: GetResult;
}

/**
 * A {@link ServerRead} in a form JSON can carry. Point values travel as
 * base64 of the typed arrays' bytes: JSON would turn NaN, a legal field
 * value, into null. The bytes are in the server's byte order, little-endian
 * on every platform tscache supports, as the library's own payloads are.
 */
export interface Dehydrated {
  range: Range;
  /** Base64 of the timestamps as a Float64Array. */
  timestamps: string;
  /** Field name → base64 of its values, in the field's dtype. */
  fields: Record<string, string>;
  coverage: Range[];
  misses: Miss[];
}

const ARRAYS: Readonly<Record<Dtype, new (buffer: ArrayBuffer) => FieldArray>> =
  {
    f64: Float64Array,
    f32: Float32Array,
    i32: Int32Array,
    u32: Uint32Array,
    i16: Int16Array,
    u16: Uint16Array,
    i8: Int8Array,
    u8: Uint8Array,
  };

/** btoa takes a binary string, and String.fromCharCode bounded arguments. */
const CHUNK = 0x8000;

function toBase64(view: ArrayBufferView): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function fromBase64(text: string): ArrayBuffer {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * `fields` with `fn` applied to each value. Object.fromEntries defines own
 * properties, so a field named like an Object.prototype member (`__proto__`
 * is a legal name) stays a field.
 */
function mapFields<A, B>(
  fields: Record<string, A>,
  fn: (value: A, name: string) => B,
): Record<string, B> {
  return Object.fromEntries(
    Object.entries(fields).map(([name, value]) => [name, fn(value, name)]),
  );
}

export function dehydrate({ range, result }: ServerRead): Dehydrated {
  return {
    range,
    timestamps: toBase64(result.timestamps),
    fields: mapFields(result.fields, toBase64),
    coverage: result.coverage,
    misses: result.misses,
  };
}

/** The server's read as it was, typed arrays and all. */
export function rehydrate(config: CacheConfig, value: Dehydrated): ServerRead {
  const fields = mapFields(value.fields, (text, name) => {
    const dtype = Object.hasOwn(config.fields, name)
      ? config.fields[name]
      : undefined;
    if (dtype === undefined) {
      throw new Error(
        `the server read a field ${name} that ${config.id} lacks`,
      );
    }
    return new ARRAYS[dtype](fromBase64(text));
  });
  return {
    range: value.range,
    result: {
      timestamps: new Float64Array(fromBase64(value.timestamps)),
      fields,
      coverage: value.coverage,
      misses: value.misses,
    },
  };
}

/** The first index of sorted `timestamps` past `t` (or at it, if `at`). */
function bound(timestamps: Float64Array, t: number, at: boolean): number {
  let lo = 0;
  let hi = timestamps.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const value = timestamps[mid] as number;
    if (value < t || (!at && value === t)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The parts of `range` that no range of sorted `coverage` holds. */
function uncovered(range: Range, coverage: Range[], interval: number): Range[] {
  const parts: Range[] = [];
  let start = range.start;
  for (const covered of coverage) {
    if (covered.end < start) continue;
    if (covered.start > range.end) break;
    if (covered.start > start) {
      parts.push({ start, end: covered.start - interval });
    }
    start = covered.end + interval;
  }
  if (start <= range.end) parts.push({ start, end: range.end });
  return parts;
}

/**
 * Puts the covered ranges of a server's read into `cache`, each with its
 * range, so an empty slot inside one is a confirmed gap the browser never
 * fetches. Only where the cache does not cover them yet: with a
 * SharedWorker, another tab may hold a range from a later fetch than the
 * server's, and a seed must not replace it. Points outside the coverage,
 * such as a provisional tail, stay out; the browser fetches them itself.
 */
export async function putCovered(
  cache: CacheHandle,
  config: CacheConfig,
  { range, result }: ServerRead,
): Promise<void> {
  const known = await cache.get(range, { cacheOnly: true });
  const parts = result.coverage.flatMap((covered) =>
    uncovered(covered, known.coverage, config.interval),
  );
  const { timestamps } = result;
  await Promise.all(
    parts.map((part) => {
      const from = bound(timestamps, part.start, true);
      const to = bound(timestamps, part.end, false);
      // put() transfers its arrays to the worker, and the page still
      // renders these: each part gets copies.
      return cache.put(
        {
          timestamps: timestamps.slice(from, to),
          fields: mapFields(result.fields, (values) => values.slice(from, to)),
        },
        { range: part },
      );
    }),
  );
}

/** The id of the script element that carries the server's read. */
export const SERVER_READ = "tscache-read";

/**
 * `value` as a JSON script element for the page. Every `<` in the JSON is
 * escaped, so no string in it can close the element early.
 */
export function jsonScript(id: string, value: unknown): string {
  const json = JSON.stringify(value).replaceAll("<", "\\u003c");
  return `<script id="${id}" type="application/json">${json}</script>`;
}

/** The value a {@link jsonScript} element carries in this page. */
export function readJson<T>(id: string): T {
  const text = document.getElementById(id)?.textContent;
  if (text == null) {
    throw new Error(`the page has no #${id}; was it server-rendered?`);
  }
  return JSON.parse(text) as T;
}
