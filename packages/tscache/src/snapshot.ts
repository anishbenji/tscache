/**
 * A Snapshot as a plain JSON value and back (docs/architecture.md §2.8,
 * N38). Buffers travel as base64 of their bytes, so NaN, a legal field
 * value that JSON would turn into null, survives. Imports types and errors
 * only: the '.' entry carries no engine code. No DOM: btoa/atob exist in
 * browsers and Node.
 */

import { show, TscacheError } from "./errors";
import type {
  DenseSegmentPayload,
  EncodedSegmentPayload,
  EncodedSnapshot,
  Snapshot,
} from "./types";

/** btoa takes a binary string; String.fromCharCode takes bounded arguments. */
const CHUNK = 0x8000;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function fail(message: string): never {
  throw new TscacheError(`invalid encoded snapshot: ${message}`);
}

function fromBase64(text: unknown, what: string): Uint8Array<ArrayBuffer> {
  if (typeof text !== "string") fail(`${what} must be a base64 string`);
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    return fail(`${what} is not valid base64`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encodePayload(p: DenseSegmentPayload): EncodedSegmentPayload {
  return {
    format: p.format,
    layout: p.layout,
    start: p.start,
    count: p.count,
    interval: p.interval,
    alignmentOffset: p.alignmentOffset,
    mask: toBase64(p.mask),
    fields: p.fields.map(({ name, dtype, data }) => ({
      name,
      dtype,
      data: toBase64(new Uint8Array(data)),
    })),
  };
}

/**
 * The snapshot with each payload's mask and field data as base64 strings:
 * a plain JSON value to serialise with `JSON.stringify`, next to the app's
 * own data. Escaping for a `<script>` element stays with the app.
 */
export function encodeSnapshot(snapshot: Snapshot): EncodedSnapshot {
  const { segments, ...envelope } = snapshot;
  return {
    ...envelope,
    range: { ...envelope.range },
    fields: { ...envelope.fields },
    coverage: envelope.coverage.map((r) => ({ ...r })),
    segments: segments.map(encodePayload),
  };
}

function checkRange(
  value: unknown,
  what: string,
): { start: number; end: number } {
  if (
    !isObject(value) ||
    typeof value.start !== "number" ||
    typeof value.end !== "number"
  ) {
    fail(`${what} must be a range of numbers`);
  }
  return { start: value.start, end: value.end };
}

function checkNumber(value: unknown, what: string): number {
  if (typeof value !== "number") fail(`${what} must be a number`);
  return value;
}

function decodePayload(value: unknown, i: number): DenseSegmentPayload {
  const what = `segments[${i}]`;
  if (!isObject(value)) fail(`${what} must be an object`);
  if (value.format !== 1) fail(`${what}.format must be 1`);
  if (value.layout !== "dense") fail(`${what}.layout must be "dense"`);
  if (!Array.isArray(value.fields)) fail(`${what}.fields must be an array`);
  const fields = Array.from(value.fields, (entry: unknown, k: number) => {
    const at = `${what}.fields[${k}]`;
    if (
      !isObject(entry) ||
      typeof entry.name !== "string" ||
      typeof entry.dtype !== "string"
    ) {
      fail(`${at} must have a name and a dtype`);
    }
    return {
      name: entry.name,
      dtype: entry.dtype as DenseSegmentPayload["fields"][number]["dtype"],
      data: fromBase64(entry.data, `${at}.data`).buffer,
    };
  });
  return {
    format: 1,
    layout: "dense",
    start: checkNumber(value.start, `${what}.start`),
    count: checkNumber(value.count, `${what}.count`),
    interval: checkNumber(value.interval, `${what}.interval`),
    alignmentOffset: checkNumber(
      value.alignmentOffset,
      `${what}.alignmentOffset`,
    ),
    mask: fromBase64(value.mask, `${what}.mask`),
    fields,
  };
}

/**
 * The snapshot an {@link encodeSnapshot} value carries. Checks the shape
 * (every array position, holes included) and the base64 only, and leaves its input unchanged; whether the snapshot
 * fits a cache (lengths, ordering, alignment, schema) is `hydrate`'s check.
 * Throws TscacheError for anything else.
 */
export function decodeSnapshot(encoded: EncodedSnapshot): Snapshot {
  const e: unknown = encoded;
  if (!isObject(e)) fail(`must be an object, got ${show(e)}`);
  if (e.format !== 1) fail("format must be 1");
  const fields = e.fields;
  if (
    !isObject(fields) ||
    !Object.values(fields).every((dtype) => typeof dtype === "string")
  ) {
    fail("fields must map names to dtypes");
  }
  if (!Array.isArray(e.coverage)) fail("coverage must be an array");
  if (!Array.isArray(e.segments)) fail("segments must be an array");
  if (e.version !== undefined && typeof e.version !== "string") {
    fail("version must be a string");
  }
  const snapshot: Snapshot = {
    format: 1,
    interval: checkNumber(e.interval, "interval"),
    alignmentOffset: checkNumber(e.alignmentOffset, "alignmentOffset"),
    fields: { ...(fields as Snapshot["fields"]) },
    range: checkRange(e.range, "range"),
    coverage: Array.from(e.coverage, (r: unknown, i: number) =>
      checkRange(r, `coverage[${i}]`),
    ),
    segments: Array.from(e.segments, decodePayload),
  };
  if (e.version !== undefined) snapshot.version = e.version as string;
  if (e.finalizedUntil !== undefined) {
    snapshot.finalizedUntil = checkNumber(e.finalizedUntil, "finalizedUntil");
  }
  return snapshot;
}
