/**
 * A Snapshot as a plain JSON value and back (docs/architecture.md §2.8,
 * N38). Buffers travel as base64 of their bytes, so NaN, a legal field
 * value that JSON would turn into null, survives. Imports types and errors
 * only: the '.' entry carries no engine code. No DOM (base64.ts).
 */

import { fromBase64 as decodeBase64, toBase64 } from "./base64";
import { show, TscacheError } from "./errors";
import type {
  DenseSegmentPayload,
  EncodedSegmentPayload,
  EncodedSnapshot,
  ResolvedCalendarInterval,
  Snapshot,
} from "./types";

function fail(message: string): never {
  throw new TscacheError(`invalid encoded snapshot: ${message}`);
}

function fromBase64(text: unknown, what: string): Uint8Array<ArrayBuffer> {
  if (typeof text !== "string") fail(`${what} must be a base64 string`);
  try {
    return decodeBase64(text);
  } catch {
    return fail(`${what} is not valid base64`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encodePayload(p: DenseSegmentPayload): EncodedSegmentPayload {
  const rest = {
    layout: p.layout,
    start: p.start,
    count: p.count,
    mask: toBase64(p.mask),
    fields: p.fields.map(({ name, dtype, data }) => ({
      name,
      dtype,
      data: toBase64(new Uint8Array(data)),
    })),
  };
  return p.format === 2
    ? { format: 2, ...rest, grid: { ...p.grid }, startSlot: p.startSlot }
    : {
        format: 1,
        ...rest,
        interval: p.interval,
        alignmentOffset: p.alignmentOffset,
      };
}

/**
 * The snapshot with each payload's mask and field data as base64 strings:
 * a plain JSON value to serialise with `JSON.stringify`, next to the app's
 * own data. Escaping for a `<script>` element stays with the app.
 */
export function encodeSnapshot(snapshot: Snapshot): EncodedSnapshot {
  const { segments, ...envelope } = snapshot;
  const copies = {
    range: { ...envelope.range },
    fields: { ...envelope.fields },
    coverage: envelope.coverage.map((r) => ({ ...r })),
    segments: segments.map(encodePayload),
  };
  // A format 2 envelope's grid and slot indices are plain JSON already.
  return envelope.format === 2
    ? {
        ...envelope,
        ...copies,
        grid: { ...envelope.grid },
        rangeSlots: [...envelope.rangeSlots],
        coverageSlots: envelope.coverageSlots.map((pair) => [...pair]),
      }
    : { ...envelope, ...copies };
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

/** A pair of numbers, checked position by position, holes included. */
function checkPair(value: unknown, what: string): [number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== "number" ||
    typeof value[1] !== "number"
  ) {
    fail(`${what} must be an array of exactly two numbers`);
  }
  return [value[0], value[1]];
}

/**
 * A format 2 value's `grid`, checked for shape only: an object with a
 * string `unit`. What it means is `hydrate`'s to check.
 */
function checkGrid(value: unknown, what: string): ResolvedCalendarInterval {
  if (!isObject(value) || typeof value.unit !== "string") {
    fail(`${what} must be an object with a string unit`);
  }
  return { ...value } as unknown as ResolvedCalendarInterval;
}

/** The format of an envelope or payload: 1 (a fixed grid) or 2 (a calendar grid). */
function checkFormat(value: unknown, what: string): 1 | 2 {
  if (value !== 1 && value !== 2) fail(`${what} must be 1 or 2`);
  return value;
}

function decodePayload(value: unknown, i: number): DenseSegmentPayload {
  const what = `segments[${i}]`;
  if (!isObject(value)) fail(`${what} must be an object`);
  const format = checkFormat(value.format, `${what}.format`);
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
  const rest = {
    layout: "dense" as const,
    start: checkNumber(value.start, `${what}.start`),
    count: checkNumber(value.count, `${what}.count`),
    mask: fromBase64(value.mask, `${what}.mask`),
    fields,
  };
  // Each payload is rebuilt in its own format.
  return format === 2
    ? {
        format,
        ...rest,
        grid: checkGrid(value.grid, `${what}.grid`),
        startSlot: checkNumber(value.startSlot, `${what}.startSlot`),
      }
    : {
        format,
        ...rest,
        interval: checkNumber(value.interval, `${what}.interval`),
        alignmentOffset: checkNumber(
          value.alignmentOffset,
          `${what}.alignmentOffset`,
        ),
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
  const format = checkFormat(e.format, "format");
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
  const rest = {
    fields: { ...(fields as Snapshot["fields"]) },
    range: checkRange(e.range, "range"),
    coverage: Array.from(e.coverage, (r: unknown, i: number) =>
      checkRange(r, `coverage[${i}]`),
    ),
    segments: Array.from(e.segments, decodePayload),
  };
  let snapshot: Snapshot;
  if (format === 2) {
    // The slot indices, by shape: that there is one pair for each coverage
    // range, and what the indices mean, are `hydrate`'s to check.
    if (!Array.isArray(e.coverageSlots)) {
      fail("coverageSlots must be an array");
    }
    snapshot = {
      format,
      grid: checkGrid(e.grid, "grid"),
      ...rest,
      rangeSlots: checkPair(e.rangeSlots, "rangeSlots"),
      coverageSlots: Array.from(e.coverageSlots, (pair: unknown, i: number) =>
        checkPair(pair, `coverageSlots[${i}]`),
      ),
    };
  } else {
    snapshot = {
      format,
      interval: checkNumber(e.interval, "interval"),
      alignmentOffset: checkNumber(e.alignmentOffset, "alignmentOffset"),
      ...rest,
    };
  }
  if (e.version !== undefined) snapshot.version = e.version as string;
  if (e.finalizedUntil !== undefined) {
    snapshot.finalizedUntil = checkNumber(e.finalizedUntil, "finalizedUntil");
  }
  return snapshot;
}
