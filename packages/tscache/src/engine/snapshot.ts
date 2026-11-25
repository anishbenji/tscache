/**
 * Snapshots (docs/architecture.md §2.8, §4.5; N34–N36): what a cache knows
 * about a range, as §3.4 payloads clipped to it, and the full validation of
 * an incoming snapshot before `hydrate` changes anything. Slot terms inside;
 * every ms↔slot conversion goes through grid.ts.
 */

import type { CoverageIndex } from "../coverage";
import { InvalidRangeError, show, TscacheError } from "../errors";
import {
  type Grid,
  gridOf,
  lookupBudgetOf,
  type SlotRange,
  slotAtOrAfter,
  slotOf,
  toMs,
} from "../grid";
import { DenseSegment } from "../segment/dense";
import { gridMismatch, kindOf, segmentFromPayload } from "../segment/payload";
import type { Segment, SegmentOptions } from "../segment/types";
import type {
  DenseSegmentPayload,
  ResolvedCacheConfig,
  Snapshot,
} from "../types";
import { firstEndingFrom } from "./read";

/** The state a snapshot is taken from. */
export interface SnapshotSource {
  config: ResolvedCacheConfig;
  /** The cache's grid; default: the grid of the config. */
  grid?: Grid;
  segments: readonly Segment[];
  coverage: CoverageIndex;
  version: string | undefined;
  finalizedUntil: number | undefined;
}

/** A validated incoming snapshot, in slot terms. */
export interface ValidSnapshot {
  /** The snapshot's range, in slots. */
  range: SlotRange;
  version: string | undefined;
  /** The snapshot's watermark with its slot. */
  watermark: { t: number; slot: number } | undefined;
  coverage: SlotRange[];
  /** Decoded payloads: ascending, disjoint, inside the request, none empty. */
  segments: Segment[];
}

function segmentOptions(
  config: ResolvedCacheConfig,
  grid: Grid,
): SegmentOptions {
  return {
    grid,
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

/**
 * What the cache knows about `request` (already snapped outward). With
 * `parts` (ascending, disjoint, inside `request`), the segments hold only
 * the present points inside those parts: one payload per segment per part,
 * as a persisted page record keeps them (§4.10.2).
 */
export function takeSnapshot(
  source: SnapshotSource,
  request: SlotRange,
  parts: readonly SlotRange[] = [request],
): Snapshot {
  const { config } = source;
  const grid = source.grid ?? gridOf(config);
  const options = segmentOptions(config, grid);
  const segments: DenseSegmentPayload[] = [];
  const all = source.segments;
  for (const part of parts) {
    for (let i = firstEndingFrom(all, part.start); i < all.length; i++) {
      const segment = all[i] as Segment;
      if ((segment.extent as SlotRange).start > part.end) break;
      const payload = clipped(segment, part, options);
      if (payload !== undefined) segments.push(payload);
    }
  }
  const covered = source.coverage.covered(request);
  const rest = {
    fields: { ...config.fields },
    range: toMs(request, grid),
    coverage: covered.map((r) => toMs(r, grid)),
  };
  // A calendar grid writes format 2 (§2.8, N114): its descriptor, and beside
  // each instant that names a slot the slot index it was written from
  // (N113), which is the state's own and costs no conversion.
  const snapshot: Snapshot =
    grid.calendar === undefined
      ? {
          format: 1,
          interval: grid.interval,
          alignmentOffset: grid.alignmentOffset,
          ...rest,
          segments,
        }
      : {
          format: 2,
          grid: { ...grid.interval },
          ...rest,
          rangeSlots: [request.start, request.end],
          coverageSlots: covered.map((r) => [r.start, r.end]),
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

/**
 * (1) The envelope must describe this cache's grid, in the grid's format (1
 * for a fixed grid, 2 for a calendar grid), and its schema.
 */
function checkEnvelope(
  s: unknown,
  config: ResolvedCacheConfig,
): asserts s is Record<string, unknown> {
  if (!isObject(s)) fail("must be an object");
  const mismatch = gridMismatch(s, config);
  if (mismatch !== undefined) fail(mismatch);
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

/** The number of entries of an array; 0 for anything else, which a later rule refuses. */
function lengthOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/**
 * A snapshot's charge (N113), from its shape alone: 24 for the range, 36
 * for each coverage range (its two ends, and the two ends of the one part
 * it applies), 12 for each payload's start and 12 for a watermark. It is
 * at least the offset lookups of the snapshot's validation, and of its
 * application into a cache that knows nothing of its coverage. A receiver
 * that already covers stretches inside a coverage range applies one part
 * more for each, at 12 lookups a part, and while a reader is subscribed
 * the RPC server converts each range of the call's `cacheChanged` once
 * more, at 12 lookups a range: both follow the receiver's own state and
 * are outside the charge (§4.5).
 */
export function chargeOf(s: Record<string, unknown>): number {
  return (
    24 +
    36 * lengthOf(s.coverage) +
    12 * lengthOf(s.segments) +
    (s.finalizedUntil === undefined ? 0 : 12)
  );
}

/**
 * The charge against the lookup budget of a grid that looks offsets up:
 * checked after rule 1 and before rule 2, the first that converts an
 * instant, so a refusal costs no lookup.
 */
function checkCharge(s: Record<string, unknown>, grid: Grid): void {
  const budget = lookupBudgetOf(grid);
  if (budget === undefined) return;
  const charge = chargeOf(s);
  if (charge > budget) {
    fail(
      `its ${lengthOf(s.coverage)} coverage ranges and ${lengthOf(s.segments)} payloads charge ${charge} offset lookups, above the budget of ${budget}`,
    );
  }
}

/**
 * An aligned safe-integer range in slots, or the failure `what`. Each end
 * is converted once (N113).
 */
function slotRange(value: unknown, grid: Grid, what: string): SlotRange {
  if (!isObject(value)) fail(`${what} must be a range`);
  const { start, end } = value;
  if (typeof start !== "number" || typeof end !== "number") {
    fail(`${what} must have aligned safe-integer endpoints`);
  }
  let slots: SlotRange;
  try {
    const first = slotOf(start, grid);
    slots = { start: first, end: end === start ? first : slotOf(end, grid) };
  } catch {
    return fail(`${what} must have aligned safe-integer endpoints`);
  }
  if (start > end) fail(`${what} starts after it ends`);
  return slots;
}

/** Whether a value is a pair of numbers naming exactly these two slots. */
function isSlotPair(value: unknown, slots: SlotRange): boolean {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value[0] === slots.start &&
    value[1] === slots.end
  );
}

/**
 * (6) Format 2 only (N113): beside each instant that names a slot, the
 * snapshot stores the slot index its writer gave it, and each must be the
 * slot the instant has here. `rangeSlots` is a pair for the range, and
 * `coverageSlots` one pair for each coverage range, in order. A payload's
 * `startSlot` is checked with its payload (rule 5).
 */
function checkAnchors(
  s: Record<string, unknown>,
  request: SlotRange,
  coverage: readonly SlotRange[],
): void {
  if (!isSlotPair(s.rangeSlots, request)) {
    fail(
      `rangeSlots must be the slots [${request.start}, ${request.end}] of the range here`,
    );
  }
  const pairs = s.coverageSlots;
  if (!Array.isArray(pairs) || pairs.length !== coverage.length) {
    fail(
      `coverageSlots must be an array of ${coverage.length} pairs, one for each coverage range`,
    );
  }
  for (const [i, slots] of coverage.entries()) {
    if (!isSlotPair(pairs[i], slots)) {
      fail(
        `coverageSlots[${i}] must be the slots [${slots.start}, ${slots.end}] of coverage[${i}] here`,
      );
    }
  }
}

/** (3) Optional metadata, validated as put validates meta (§4.5). */
function checkMeta(
  s: Record<string, unknown>,
  grid: Grid,
): Pick<ValidSnapshot, "version" | "watermark"> {
  const { version, finalizedUntil } = s;
  if (
    version !== undefined &&
    (typeof version !== "string" || version.length === 0)
  ) {
    fail(`version must be a non-empty string, got ${kindOf(version)}`);
  }
  const valid = version as string | undefined;
  if (finalizedUntil === undefined)
    return { version: valid, watermark: undefined };
  if (typeof finalizedUntil !== "number") {
    fail(`finalizedUntil must be a number, got ${kindOf(finalizedUntil)}`);
  }
  try {
    const slot = slotAtOrAfter(finalizedUntil, grid);
    return { version: valid, watermark: { t: finalizedUntil, slot } };
  } catch (error) {
    if (!(error instanceof InvalidRangeError)) throw error;
    // Not error.message, which prints the value (#142 A).
    return fail(
      `finalizedUntil must be a timestamp within ±(2^53 - 1) with a grid point at or after it, got ${kindOf(finalizedUntil)}`,
    );
  }
}

/**
 * (4) Ascending, disjoint, not adjacent, inside the request, and below the
 * snapshot's own watermark when it has one (N69).
 */
function checkCoverage(
  value: unknown,
  request: SlotRange,
  grid: Grid,
  watermark: ValidSnapshot["watermark"],
): SlotRange[] {
  if (!Array.isArray(value)) fail("coverage must be an array");
  const out: SlotRange[] = [];
  for (const [i, item] of value.entries()) {
    const r = slotRange(item, grid, `coverage[${i}]`);
    if (r.start < request.start || r.end > request.end) {
      fail(`coverage[${i}] lies outside the range`);
    }
    const last = out.at(-1);
    if (last !== undefined && r.start <= last.end + 1) {
      fail(`coverage[${i}] is not after coverage[${i - 1}] with a gap`);
    }
    // Slots at or after the watermark are provisional by the snapshot's own
    // account: claiming them as covered is a corruption, never clipped.
    if (watermark !== undefined && r.end >= watermark.slot) {
      fail(`coverage[${i}] reaches past finalizedUntil ${show(watermark.t)}`);
    }
    out.push(r);
  }
  return out;
}

/** (5) Each payload decodes for this cache; extents ascending, disjoint, inside. */
function checkSegments(
  value: unknown,
  request: SlotRange,
  options: SegmentOptions,
): Segment[] {
  if (!Array.isArray(value)) fail("segments must be an array");
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
 * (§4.5): envelope, the lookup charge, range, metadata, coverage, segments
 * and, for format 2, the stored slot indices. Throws TscacheError at the
 * first failure; never changes anything.
 */
export function validateSnapshot(
  input: unknown,
  config: ResolvedCacheConfig,
  grid: Grid = gridOf(config),
): ValidSnapshot {
  checkEnvelope(input, config);
  checkCharge(input, grid);
  const request = slotRange(input.range, grid, "range");
  const meta = checkMeta(input, grid);
  const coverage = checkCoverage(input.coverage, request, grid, meta.watermark);
  const segments = checkSegments(
    input.segments,
    request,
    segmentOptions(config, grid),
  );
  if (grid.calendar !== undefined) checkAnchors(input, request, coverage);
  return { range: request, ...meta, coverage, segments };
}
