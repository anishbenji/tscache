// Server rendering through tscache's snapshot API (docs/architecture.md
// §2.8), the same in every framework. The server reads a range with its own
// client and `get(range, { snapshot: true })`, and writes both forms of the
// answer into the page: the columns, which the browser renders first so its
// hydration render matches the server's, and the snapshot, which the
// browser applies to its cache with `hydrate`, so it fetches only the rest
// (a provisional tail, say).

import {
  type CacheConfig,
  type CacheHandle,
  type Dtype,
  decodeSnapshot,
  type EncodedSnapshot,
  encodeSnapshot,
  type FieldArray,
  type GetResult,
  type HydrateResult,
  type Miss,
  type Range,
  type Snapshot,
  TscacheError,
} from "tscache";

/**
 * What a server read: the range it asked for, the cache's answer and the
 * snapshot taken from the same state (N36).
 */
export interface ServerRead {
  range: Range;
  result: GetResult;
  snapshot: Snapshot;
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
  /** The snapshot as JSON (`encodeSnapshot`). */
  snapshot: EncodedSnapshot;
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

export function dehydrate({ range, result, snapshot }: ServerRead): Dehydrated {
  return {
    range,
    timestamps: toBase64(result.timestamps),
    fields: mapFields(result.fields, toBase64),
    coverage: result.coverage,
    misses: result.misses,
    snapshot: encodeSnapshot(snapshot),
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
    snapshot: decodeSnapshot(value.snapshot),
  };
}

/**
 * Applies a server's snapshot to `cache` (§2.8, N35): only where the cache
 * neither covers nor holds a provisional point, in one call inside the
 * worker, so another tab's newer fetch is never replaced; a snapshot of
 * another dataset version is refused. The snapshot is cloned, so one read
 * can seed every client. A worker from before `hydrate` answers "unknown
 * op": that counts as nothing applied, and the cache fetches instead (N37).
 * Any other failure is a bug and propagates.
 */
export async function hydrateRead(
  cache: CacheHandle,
  { snapshot }: ServerRead,
): Promise<HydrateResult> {
  try {
    return await cache.hydrate(snapshot);
  } catch (error) {
    // Exactly the RPC server's answer to an op it lacks (§4.7).
    if (
      error instanceof TscacheError &&
      error.message === "unknown op hydrate"
    ) {
      return { applied: [] };
    }
    throw error;
  }
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
