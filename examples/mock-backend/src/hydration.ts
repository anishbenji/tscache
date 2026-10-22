// SSR hydration through tscache's public API. The server reads a range with
// an in-process client and writes the covered parts of the answer, each with
// its points, into the HTML. The browser puts them back with their ranges,
// so its cache knows those ranges are covered (an empty slot inside one is a
// confirmed gap) and fetches only the rest, such as a provisional tail.

import type {
  CacheConfig,
  CacheHandle,
  Dtype,
  FieldArray,
  GetResult,
  Range,
} from "tscache";

/**
 * One covered range of the server's answer, with the points inside it.
 * Values travel as base64 of the typed arrays' bytes: JSON would turn NaN,
 * a legal field value, into null. The bytes are in the server's byte order,
 * which is little-endian on every platform the examples run on, as in the
 * browser.
 */
export interface Seed {
  range: Range;
  /** Base64 of the points' timestamps as a Float64Array. */
  timestamps: string;
  /** Field name → base64 of its values, in the field's dtype. */
  fields: Record<string, string>;
}

/** What the server read: the range it asked for, and its covered parts. */
export interface Hydration {
  range: Range;
  seeds: Seed[];
}

/** The id of the script element that carries the hydration. */
export const HYDRATION_ELEMENT = "tscache-hydration";

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

/** btoa takes a binary string; String.fromCharCode takes bounded arguments. */
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

function mapFields<A, B>(
  fields: Record<string, A>,
  fn: (value: A, name: string) => B,
): Record<string, B> {
  return Object.fromEntries(
    Object.entries(fields).map(([name, value]) => [name, fn(value, name)]),
  );
}

/**
 * Where the points inside `range` are in sorted `timestamps`, searching from
 * index `at`: indexes [from, to).
 */
function pointsIn(
  timestamps: Float64Array,
  range: Range,
  at: number,
): [from: number, to: number] {
  let from = at;
  while (
    from < timestamps.length &&
    (timestamps[from] as number) < range.start
  ) {
    from++;
  }
  let to = from;
  while (to < timestamps.length && (timestamps[to] as number) <= range.end) {
    to++;
  }
  return [from, to];
}

/**
 * The server's answer for `range` as seeds: one per covered range, with the
 * points inside it. Points outside coverage, such as a provisional tail,
 * stay out; the browser fetches them itself.
 */
export function dehydrate(range: Range, result: GetResult): Hydration {
  const { timestamps } = result;
  let at = 0;
  const seeds = result.coverage.map((covered): Seed => {
    const [from, to] = pointsIn(timestamps, covered, at);
    at = to;
    return {
      range: covered,
      timestamps: toBase64(timestamps.subarray(from, to)),
      fields: mapFields(result.fields, (values) =>
        toBase64(values.subarray(from, to)),
      ),
    };
  });
  return { range, seeds };
}

/**
 * `value` as a JSON script element for the page's head. Every `<` in the
 * JSON is escaped, so no string in it can end the element early.
 */
export function jsonScript(id: string, value: unknown): string {
  const json = JSON.stringify(value).replaceAll("<", "\\u003c");
  return `<script id="${id}" type="application/json">${json}</script>`;
}

/** The value a jsonScript() element carries in this page. */
export function readJson<T>(id: string): T {
  const text = document.getElementById(id)?.textContent;
  if (text == null) {
    throw new Error(`the page has no #${id}; was it server-rendered?`);
  }
  return JSON.parse(text) as T;
}

/** The hydration as a script element for the page's head. */
export function hydrationScript(hydration: Hydration): string {
  return jsonScript(HYDRATION_ELEMENT, hydration);
}

/** The hydration the server wrote into this page. */
export function readHydration(): Hydration {
  return readJson<Hydration>(HYDRATION_ELEMENT);
}

/** The parts of `range` that no range of `coverage` covers. */
function uncovered(range: Range, coverage: Range[], interval: number): Range[] {
  const gaps: Range[] = [];
  let start = range.start;
  for (const covered of coverage) {
    if (covered.start > start)
      gaps.push({ start, end: covered.start - interval });
    start = Math.max(start, covered.end + interval);
  }
  if (start <= range.end) gaps.push({ start, end: range.end });
  return gaps;
}

/**
 * Puts the seeds into the browser's cache, each with its range, where the
 * cache does not cover it yet. With a SharedWorker another tab may already
 * hold a range from a later fetch than the server's, so a seed never
 * replaces what the cache knows.
 */
export async function putSeeds(
  cache: CacheHandle,
  config: CacheConfig,
  { seeds }: Hydration,
): Promise<void> {
  for (const seed of seeds) {
    const timestamps = new Float64Array(fromBase64(seed.timestamps));
    const fields = mapFields(seed.fields, (text, name) => {
      const dtype = config.fields[name];
      if (dtype === undefined)
        throw new Error(`no field ${name} in ${config.id}`);
      return new ARRAYS[dtype](fromBase64(text));
    });
    const known = await cache.get(seed.range, { cacheOnly: true });
    let at = 0;
    for (const gap of uncovered(seed.range, known.coverage, config.interval)) {
      const [from, to] = pointsIn(timestamps, gap, at);
      at = to;
      // put() consumes its arrays (they are transferred to the worker), so
      // each gap gets copies of its own.
      await cache.put(
        {
          timestamps: timestamps.slice(from, to),
          fields: mapFields(fields, (values) => values.slice(from, to)),
        },
        { range: gap },
      );
    }
  }
}
