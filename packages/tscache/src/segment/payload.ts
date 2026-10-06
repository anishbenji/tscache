/**
 * Payload decoding (docs/architecture.md §4.2). Payloads cross trust
 * boundaries (page HTML for SSR hydration, browser storage later), so every
 * field is checked against the cache's own config before any byte is used.
 */

import { show, TscacheError } from "../errors";
import { isAligned, msOf, slotOf } from "../grid";
import type { FieldArray } from "../types";
import { DenseSegment } from "./dense";
import { FIELD_ARRAYS } from "./dtype";
import { setOwn } from "./own";
import type {
  Columns,
  DenseSegmentPayload,
  Segment,
  SegmentOptions,
} from "./types";

function fail(message: string): never {
  throw new TscacheError(`invalid segment payload: ${message}`);
}

/** The payload must describe the cache's own grid, in a known format. */
function checkGrid(p: DenseSegmentPayload, options: SegmentOptions): void {
  const { grid } = options;
  if (p.format !== 1) fail(`unsupported format ${show(p.format)}`);
  if (p.layout !== "dense") fail(`unsupported layout ${show(p.layout)}`);
  if (p.interval !== grid.interval) {
    fail(`interval ${show(p.interval)} differs from the cache grid`);
  }
  if (p.alignmentOffset !== grid.alignmentOffset) {
    fail(
      `alignmentOffset ${show(p.alignmentOffset)} differs from the cache grid`,
    );
  }
}

/** Checks start and count; returns the slot of the payload's first entry. */
function checkSpan(p: DenseSegmentPayload, options: SegmentOptions): number {
  const { grid, slotCap } = options;
  if (!isAligned(p.start, grid)) {
    fail(`start ${show(p.start)} is not an aligned safe-integer timestamp`);
  }
  if (!Number.isSafeInteger(p.count) || p.count < 1) {
    fail(`count must be a positive integer, got ${show(p.count)}`);
  }
  if (p.count > slotCap) {
    fail(`count ${p.count} exceeds the slot cap ${slotCap}`);
  }
  const first = slotOf(p.start, grid);
  // (count - 1) first: `first + count` can round before the subtraction.
  const last = first + (p.count - 1);
  if (!Number.isSafeInteger(last) || !Number.isSafeInteger(msOf(last, grid))) {
    fail("count extends beyond the last safe-integer timestamp");
  }
  return first;
}

function checkMask(p: DenseSegmentPayload): void {
  const bytes = Math.ceil(p.count / 8);
  if (!(p.mask instanceof Uint8Array) || p.mask.length !== bytes) {
    fail(`mask must be a Uint8Array of ${bytes} bytes`);
  }
  const used = p.count % 8;
  if (used !== 0 && (p.mask[bytes - 1] as number) >> used !== 0) {
    fail("mask has trailing bits set beyond count");
  }
}

type FieldEntry = DenseSegmentPayload["fields"][number];

/** Payload field entries by name; rejects a malformed or duplicated list. */
function entriesByName(
  p: DenseSegmentPayload,
  expected: number,
): Map<string, FieldEntry> {
  if (!Array.isArray(p.fields) || p.fields.length !== expected) {
    fail("fields do not match the schema");
  }
  const byName = new Map<string, FieldEntry>();
  for (const entry of p.fields) {
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
 * Field data by name, checked against the schema. Entries may come in any
 * order: a schema declared in a different key order names the same fields.
 */
function checkFields(
  p: DenseSegmentPayload,
  options: SegmentOptions,
): Map<string, ArrayBuffer> {
  const schema = Object.entries(options.fields);
  const entries = entriesByName(p, schema.length);
  const data = new Map<string, ArrayBuffer>();
  for (const [name, dtype] of schema) {
    const entry = entries.get(name);
    if (entry === undefined) fail(`field "${name}" is missing`);
    if (entry.dtype !== dtype) {
      fail(
        `field "${name}" has dtype ${show(entry.dtype)}, the schema says ${dtype}`,
      );
    }
    const bytes = p.count * FIELD_ARRAYS[dtype].BYTES_PER_ELEMENT;
    if (
      !(entry.data instanceof ArrayBuffer) ||
      entry.data.byteLength !== bytes
    ) {
      fail(`field "${name}" data must be an ArrayBuffer of ${bytes} bytes`);
    }
    data.set(name, entry.data);
  }
  return data;
}

/** The payload's present points; absent slots' values are ignored. */
function presentPoints(
  p: DenseSegmentPayload,
  first: number,
  data: Map<string, ArrayBuffer>,
  options: SegmentOptions,
): Columns {
  const indices: number[] = [];
  for (let i = 0; i < p.count; i++) {
    if ((((p.mask[i >> 3] as number) >> (i & 7)) & 1) === 1) indices.push(i);
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
  return { slots: Float64Array.from(indices, (i) => first + i), fields };
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
  const first = checkSpan(payload, options);
  checkMask(payload);
  const data = checkFields(payload, options);
  const segment = new DenseSegment(options);
  segment.mergeFrom(presentPoints(payload, first, data, options));
  return segment;
}
