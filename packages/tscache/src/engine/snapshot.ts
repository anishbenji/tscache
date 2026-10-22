/**
 * Snapshots (docs/architecture.md §2.8, §4.5; N34–N36): what a cache knows
 * about a range, as §3.4 payloads clipped to it, and the full validation of
 * an incoming snapshot before `hydrate` changes anything. Slot terms inside;
 * every ms↔slot conversion goes through grid.ts.
 */

import type { CoverageIndex } from "../coverage";
import { InvalidRangeError, show, TscacheError } from "../errors";
import {
  isAligned,
  type SlotRange,
  slotAtOrAfter,
  slotOf,
  toMs,
} from "../grid";
import { DenseSegment } from "../segment/dense";
import { segmentFromPayload } from "../segment/payload";
import type { Segment, SegmentOptions } from "../segment/types";
import type {
  DenseSegmentPayload,
  ResolvedCacheConfig,
  Snapshot,
} from "../types";

/** The state a snapshot is taken from. */
export interface SnapshotSource {
  config: ResolvedCacheConfig;
  segments: readonly Segment[];
  coverage: CoverageIndex;
  version: string | undefined;
  finalizedUntil: number | undefined;
}

/** A validated incoming snapshot, in slot terms. */
export interface ValidSnapshot {
  version: string | undefined;
  /** The snapshot's watermark with its slot. */
  watermark: { t: number; slot: number } | undefined;
  coverage: SlotRange[];
  /** Decoded payloads: ascending, disjoint, inside the request, none empty. */
  segments: Segment[];
}

function segmentOptions(config: ResolvedCacheConfig): SegmentOptions {
  return {
    grid: config,
    fields: config.fields,
    slotCap: config.segmentSlotCap,
  };
}

/** The payload of exactly `segment`'s present points inside `request`. */
function clipped(
  segment: Segment,
  request: SlotRange,
  options: SegmentOptions,
): DenseSegmentPayload | undefined {
  const extent = segment.extent;
  if (
    extent === undefined ||
    extent.start > request.end ||
    extent.end < request.start
  ) {
    return undefined;
  }
  const points = segment.slice({
    start: Math.max(request.start, extent.start),
    end: Math.min(request.end, extent.end),
  });
  if (points.slots.length === 0) return undefined;
  // A fresh segment of just these points: its extent is tight, so the
  // payload's start and count are theirs (§4.2 layout).
  const copy = new DenseSegment(options);
  copy.mergeFrom(points);
  return copy.transferPayload();
}

/** What the cache knows about `request` (already snapped outward). */
export function takeSnapshot(
  source: SnapshotSource,
  request: SlotRange,
): Snapshot {
  const { config } = source;
  const options = segmentOptions(config);
  const segments: DenseSegmentPayload[] = [];
  for (const segment of source.segments) {
    const payload = clipped(segment, request, options);
    if (payload !== undefined) segments.push(payload);
  }
  const snapshot: Snapshot = {
    format: 1,
    interval: config.interval,
    alignmentOffset: config.alignmentOffset,
    fields: { ...config.fields },
    range: toMs(request, config),
    coverage: source.coverage.covered(request).map((r) => toMs(r, config)),
    segments,
  };
  if (source.version !== undefined) snapshot.version = source.version;
  if (source.finalizedUntil !== undefined) {
    snapshot.finalizedUntil = source.finalizedUntil;
  }
  return snapshot;
}

function fail(message: string): never {
  throw new TscacheError(`invalid snapshot: ${message}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** (1) The envelope must describe this cache's grid and schema. */
function checkEnvelope(
  s: unknown,
  config: ResolvedCacheConfig,
): asserts s is Record<string, unknown> {
  if (!isObject(s)) fail("must be an object");
  if (s.format !== 1) fail(`unsupported format ${show(s.format)}`);
  if (s.interval !== config.interval) {
    fail(`interval ${show(s.interval)} differs from the cache grid`);
  }
  if (s.alignmentOffset !== config.alignmentOffset) {
    fail(
      `alignmentOffset ${show(s.alignmentOffset)} differs from the cache grid`,
    );
  }
  const fields = s.fields;
  if (!isObject(fields)) fail("fields must be an object");
  const schema = Object.keys(config.fields);
  const same =
    Object.keys(fields).length === schema.length &&
    schema.every(
      (name) =>
        Object.hasOwn(fields, name) && fields[name] === config.fields[name],
    );
  if (!same) fail("fields differ from the cache schema");
}

/** An aligned safe-integer range in slots, or the failure `what`. */
function slotRange(
  value: unknown,
  config: ResolvedCacheConfig,
  what: string,
): SlotRange {
  if (!isObject(value)) fail(`${what} must be a range`);
  const { start, end } = value;
  if (
    typeof start !== "number" ||
    typeof end !== "number" ||
    !isAligned(start, config) ||
    !isAligned(end, config)
  ) {
    fail(`${what} must have aligned safe-integer endpoints`);
  }
  if (start > end) fail(`${what} starts after it ends`);
  return { start: slotOf(start, config), end: slotOf(end, config) };
}

/** (3) Optional metadata, validated as put validates meta (§4.5). */
function checkMeta(
  s: Record<string, unknown>,
  config: ResolvedCacheConfig,
): Pick<ValidSnapshot, "version" | "watermark"> {
  const { version, finalizedUntil } = s;
  if (
    version !== undefined &&
    (typeof version !== "string" || version.length === 0)
  ) {
    fail(`version must be a non-empty string, got ${show(version)}`);
  }
  const valid = version as string | undefined;
  if (finalizedUntil === undefined)
    return { version: valid, watermark: undefined };
  if (typeof finalizedUntil !== "number") {
    fail(`finalizedUntil must be a number, got ${show(finalizedUntil)}`);
  }
  try {
    const slot = slotAtOrAfter(finalizedUntil, config);
    return { version: valid, watermark: { t: finalizedUntil, slot } };
  } catch (error) {
    if (!(error instanceof InvalidRangeError)) throw error;
    return fail(`finalizedUntil: ${error.message}`);
  }
}

/** (4) Ascending, disjoint, not adjacent, inside the request. */
function checkCoverage(
  value: unknown,
  request: SlotRange,
  config: ResolvedCacheConfig,
): SlotRange[] {
  if (!Array.isArray(value)) fail("coverage must be an array");
  const out: SlotRange[] = [];
  for (const [i, item] of value.entries()) {
    const r = slotRange(item, config, `coverage[${i}]`);
    if (r.start < request.start || r.end > request.end) {
      fail(`coverage[${i}] lies outside the range`);
    }
    const last = out.at(-1);
    if (last !== undefined && r.start <= last.end + 1) {
      fail(`coverage[${i}] is not after coverage[${i - 1}] with a gap`);
    }
    out.push(r);
  }
  return out;
}

/** (5) Each payload decodes for this cache; extents ascending, disjoint, inside. */
function checkSegments(
  value: unknown,
  request: SlotRange,
  config: ResolvedCacheConfig,
): Segment[] {
  if (!Array.isArray(value)) fail("segments must be an array");
  const options = segmentOptions(config);
  const out: Segment[] = [];
  let lastEnd: number | undefined;
  for (const [i, payload] of value.entries()) {
    // Keeps segmentFromPayload's own message (§4.5).
    const segment = segmentFromPayload(payload as DenseSegmentPayload, options);
    const extent = segment.extent;
    if (extent === undefined) fail(`segments[${i}] holds no point`);
    if (extent.start < request.start || extent.end > request.end) {
      fail(`segments[${i}] lies outside the range`);
    }
    if (lastEnd !== undefined && extent.start <= lastEnd) {
      fail(`segments[${i}] overlaps or precedes segments[${i - 1}]`);
    }
    lastEnd = extent.end;
    out.push(segment);
  }
  return out;
}

/**
 * Validates an incoming snapshot against the cache in the documented order
 * (§4.5): envelope, range, metadata, coverage, segments. Throws TscacheError
 * at the first failure; never changes anything.
 */
export function validateSnapshot(
  input: unknown,
  config: ResolvedCacheConfig,
): ValidSnapshot {
  checkEnvelope(input, config);
  const request = slotRange(input.range, config, "range");
  const meta = checkMeta(input, config);
  const coverage = checkCoverage(input.coverage, request, config);
  const segments = checkSegments(input.segments, request, config);
  return { ...meta, coverage, segments };
}
