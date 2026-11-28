/**
 * Payload decoding (docs/architecture.md §4.2). Payloads cross trust
 * boundaries (page HTML for SSR hydration, browser storage later), so every
 * field is checked against the cache's own config before any byte is used.
 */

import { TscacheError } from "../errors";
import { inDomain, sameCalendar, slotOf } from "../grid";
import type {
  CalendarSegmentPayload,
  FieldArray,
  ResolvedCalendarInterval,
} from "../types";
import { DenseSegment } from "./dense";
import { FIELD_ARRAYS } from "./dtype";
import { setOwn } from "./own";
import type {
  Columns,
  DenseSegmentPayload,
  Segment,
  SegmentOptions,
} from "./types";

/**
 * The kind of a value a payload, snapshot or record supplied, for an error
 * message: its type only, never its text or digits (user decision #142 A).
 * A number is named finite or not but never printed: an identifier or a
 * timestamp in its place would be data an app that logs the message logs.
 */
export function kindOf(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  switch (typeof value) {
    case "number":
      return Number.isFinite(value) ? "a finite number" : "a non-finite number";
    case "string":
      return value.length === 0 ? "an empty string" : "a string";
    case "object":
      // Array.isArray throws on a revoked proxy; a diagnostic must not.
      try {
        return Array.isArray(value) ? "an array" : "an object";
      } catch {
        return "an object";
      }
    default:
      return `a ${typeof value}`;
  }
}

function fail(message: string): never {
  throw new TscacheError(`invalid segment payload: ${message}`);
}

/**
 * Whether a stored `grid` is an object naming exactly the calendar interval
 * `own` (§2.8): field by field, zones as written.
 */
function namesCalendar(value: unknown, own: ResolvedCalendarInterval): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === Object.keys(own).length &&
    sameCalendar(value as ResolvedCalendarInterval, own)
  );
}

/**
 * Why a stored envelope, payload or record does not describe a cache's
 * grid, or undefined when it does (§2.8, §3.4): it must be in the grid's
 * format, 1 for a fixed interval with equal `interval` and
 * `alignmentOffset`, 2 for a calendar interval with an equal `grid`.
 */
export function gridMismatch(
  stored: {
    format?: unknown;
    interval?: unknown;
    alignmentOffset?: unknown;
    grid?: unknown;
  },
  own: {
    interval: number | ResolvedCalendarInterval;
    alignmentOffset: number;
  },
): string | undefined {
  const { format } = stored;
  const calendar = typeof own.interval !== "number";
  if (format !== 1 && format !== 2) {
    return `format must be 1 or 2, got ${kindOf(format)}`;
  }
  if (format !== (calendar ? 2 : 1)) {
    return `format ${format} names another kind of grid than the cache's`;
  }
  if (calendar) {
    return namesCalendar(stored.grid, own.interval as ResolvedCalendarInterval)
      ? undefined
      : "grid differs from the cache grid";
  }
  for (const field of ["interval", "alignmentOffset"] as const) {
    const got = stored[field];
    if (got !== own[field]) {
      return `${field} must be the cache grid's ${own[field]}, got ${kindOf(got)}`;
    }
  }
  return undefined;
}

/** The payload must describe the cache's own grid, in the grid's format. */
function checkGrid(p: DenseSegmentPayload, options: SegmentOptions): void {
  const mismatch = gridMismatch(p, options.grid);
  if (mismatch !== undefined) fail(mismatch);
  const { layout } = p;
  if (layout !== "dense") {
    fail(`layout must be "dense", got ${kindOf(layout)}`);
  }
}

/**
 * Checks start and count; returns the slot of the payload's first entry and
 * the count. Each is read and converted once, and every later check uses
 * the returned values: an anchor costs one conversion (N113), and the
 * messages print the values that were checked. Each payload field is read
 * once; a buffer an accessor detaches or resizes after its check is not
 * re-checked (an in-process caller only; structured clone carries no
 * accessors).
 */
function checkSpan(
  p: DenseSegmentPayload,
  options: SegmentOptions,
): [first: number, count: number] {
  const { grid, slotCap } = options;
  let start: number | undefined;
  let first: number;
  try {
    start = p.start;
    first = slotOf(start, grid);
  } catch {
    return fail(
      `start must be an aligned safe-integer timestamp, got ${kindOf(start)}`,
    );
  }
  const { count } = p;
  if (!Number.isSafeInteger(count) || count < 1) {
    fail(`count must be a positive integer, got ${kindOf(count)}`);
  }
  if (count > slotCap) {
    fail(`count exceeds the slot cap ${slotCap}`);
  }
  // A calendar payload, format 2 as checkGrid found, also says which slot
  // its writer gave `start`: zone data that places the instant in another
  // slot refuses it (§4.5).
  if (grid.calendar !== undefined) {
    const { startSlot } = p as CalendarSegmentPayload;
    if (startSlot !== first) {
      fail(
        `startSlot must be the slot of start ${start} here, got ${kindOf(startSlot)}`,
      );
    }
  }
  // (count - 1) first: `first + count` can round before the subtraction.
  const last = first + (count - 1);
  if (!inDomain(last, grid)) {
    fail(
      grid.calendar === undefined
        ? "count extends beyond the last safe-integer timestamp"
        : "count extends beyond the calendar's domain",
    );
  }
  return [first, count];
}

/** Checks the mask for `count` slots; returns it, read once. */
function checkMask(p: DenseSegmentPayload, count: number): Uint8Array {
  const { mask } = p;
  const bytes = Math.ceil(count / 8);
  if (!(mask instanceof Uint8Array) || mask.length !== bytes) {
    fail(`mask must be a Uint8Array of ${bytes} bytes`);
  }
  const used = count % 8;
  if (used !== 0 && (mask[bytes - 1] as number) >> used !== 0) {
    fail("mask has trailing bits set beyond count");
  }
  return mask;
}

type FieldEntry = DenseSegmentPayload["fields"][number];

/**
 * Payload field entries by name; rejects a malformed or duplicated list.
 * The list is read once; each entry is checked and kept as read.
 */
function entriesByName(
  p: DenseSegmentPayload,
  expected: number,
): Map<string, FieldEntry> {
  const { fields } = p;
  if (!Array.isArray(fields) || fields.length !== expected) {
    fail("fields do not match the schema");
  }
  const byName = new Map<string, FieldEntry>();
  for (const entry of fields) {
    if (typeof entry !== "object" || entry === null) {
      fail("fields do not match the schema");
    }
    byName.set(entry.name, entry);
  }
  // A duplicate name collapses two entries into one.
  if (byName.size !== expected) fail("fields do not match the schema");
  return byName;
}

/**
 * Field data by name, checked against the schema for `count` slots. Entries
 * may come in any order: a schema declared in a different key order names
 * the same fields.
 */
function checkFields(
  p: DenseSegmentPayload,
  count: number,
  options: SegmentOptions,
): Map<string, ArrayBuffer> {
  const schema = Object.entries(options.fields);
  const entries = entriesByName(p, schema.length);
  const data = new Map<string, ArrayBuffer>();
  for (const [name, dtype] of schema) {
    const entry = entries.get(name);
    if (entry === undefined) fail(`field "${name}" is missing`);
    const got: unknown = entry.dtype;
    if (got !== dtype) {
      fail(
        `field "${name}" dtype must be ${dtype} as the schema says, got ${kindOf(got)}`,
      );
    }
    const bytes = count * FIELD_ARRAYS[dtype].BYTES_PER_ELEMENT;
    const buffer: unknown = entry.data;
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== bytes) {
      fail(`field "${name}" data must be an ArrayBuffer of ${bytes} bytes`);
    }
    data.set(name, buffer);
  }
  return data;
}

/** The payload's present points; absent slots' values are ignored. */
function presentPoints(
  mask: Uint8Array,
  first: number,
  count: number,
  data: Map<string, ArrayBuffer>,
  options: SegmentOptions,
): Columns {
  const indices: number[] = [];
  for (let i = 0; i < count; i++) {
    if ((((mask[i >> 3] as number) >> (i & 7)) & 1) === 1) indices.push(i);
  }
  const fields: Record<string, FieldArray> = {};
  for (const [name, dtype] of Object.entries(options.fields)) {
    const ctor = FIELD_ARRAYS[dtype];
    const source = new ctor(data.get(name) as ArrayBuffer);
    const out = new ctor(indices.length);
    for (let k = 0; k < indices.length; k++) {
      out[k] = source[indices[k] as number] as number;
    }
    setOwn(fields, name, out);
  }
  // Indexed rather than Float64Array.from, which iterates its source.
  const slots = new Float64Array(indices.length);
  for (let k = 0; k < indices.length; k++) {
    slots[k] = first + (indices[k] as number);
  }
  return { slots, fields };
}

/**
 * Rebuilds a segment from a payload, copying its buffers so the segment
 * shares nothing with the payload's owner. Throws TscacheError for an
 * invalid payload. The result's extent is the tight bounds of the present
 * points, whatever padding the payload carried.
 */
export function segmentFromPayload(
  payload: DenseSegmentPayload,
  options: SegmentOptions,
): Segment {
  if (typeof payload !== "object" || payload === null) {
    fail("payload must be an object");
  }
  checkGrid(payload, options);
  const [first, count] = checkSpan(payload, options);
  const mask = checkMask(payload, count);
  const data = checkFields(payload, count, options);
  const segment = new DenseSegment(options);
  segment.mergeFrom(presentPoints(mask, first, count, data, options));
  return segment;
}
