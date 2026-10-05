import { ConfigError } from "../errors";
import { MAX_SLOT_CAP } from "../segment/types";
import {
  type CacheConfig,
  DTYPES,
  type Dtype,
  type ResolvedCacheConfig,
} from "../types";

export const DEFAULT_GAP_SPLIT_K = 4;
export const DEFAULT_SEGMENT_SLOT_CAP = 32_768;

function fail(message: string): never {
  throw new ConfigError(message);
}

function requirePositiveSafeInteger(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    fail(`${what} must be a positive integer, got ${String(value)}`);
  }
  return value;
}

function validateId(id: unknown): string {
  if (typeof id !== "string" || id.length === 0) {
    fail(`id must be a non-empty string, got ${String(id)}`);
  }
  return id;
}

/**
 * Any integer offset is accepted (architecture §2.2 only requires
 * `(t - alignmentOffset) % interval === 0`) and normalized into
 * [0, interval): the grid is unchanged, and configs naming the same grid
 * resolve identically. Integers only, because timestamps are integers.
 */
function validateAlignmentOffset(offset: unknown, interval: number): number {
  if (offset === undefined) return 0;
  if (typeof offset !== "number" || !Number.isSafeInteger(offset)) {
    fail(`alignmentOffset must be an integer, got ${String(offset)}`);
  }
  // Add interval only to a negative remainder: `r + interval` then stays below
  // interval, so the result is exact even when interval nears 2^53.
  // Math.abs turns a -0 remainder into 0.
  const r = offset % interval;
  return r < 0 ? r + interval : Math.abs(r);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateFields(
  fields: CacheConfig["fields"],
): Readonly<Record<string, Dtype>> {
  if (!isPlainObject(fields)) {
    fail("fields must be an object mapping field names to dtypes");
  }
  const names = Object.keys(fields);
  if (names.length === 0) fail("fields must declare at least one field");
  for (const name of names) {
    if (name.length === 0) fail("field names must be non-empty strings");
    const dtype = fields[name];
    if (!DTYPES.includes(dtype as Dtype)) {
      fail(
        `field "${name}" has unknown dtype ${String(dtype)}; expected one of ${DTYPES.join(", ")}`,
      );
    }
  }
  return Object.freeze({ ...fields });
}

function validateSegmentSlotCap(value: unknown): number {
  const cap = requirePositiveSafeInteger(value, "segmentSlotCap");
  if (cap > MAX_SLOT_CAP) {
    fail(`segmentSlotCap must be at most ${MAX_SLOT_CAP}, got ${cap}`);
  }
  return cap;
}

function validateVersion(version: unknown): string | undefined {
  if (version === undefined) return undefined;
  if (typeof version !== "string" || version.length === 0) {
    fail(`version must be a non-empty string when set, got ${String(version)}`);
  }
  return version;
}

function validateFinalizedUntil(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(
      `finalizedUntil must be a finite number when set, got ${String(value)}`,
    );
  }
  return value;
}

function validateWarnFlag(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    fail(`warnOnOverlapDiff must be a boolean when set, got ${String(value)}`);
  }
  return value;
}

/**
 * Validates a consumer CacheConfig and applies documented defaults.
 * Throws ConfigError naming the first offending field. The result is frozen
 * and holds a defensive copy of `fields`.
 */
export function resolveCacheConfig(config: CacheConfig): ResolvedCacheConfig {
  // Untyped callers (plain JS, RPC params) can pass anything; keep the
  // ConfigError contract (architecture §2.6) instead of a TypeError.
  if (!isPlainObject(config)) {
    fail(`config must be an object, got ${String(config)}`);
  }
  const id = validateId(config.id);
  const interval = requirePositiveSafeInteger(config.interval, "interval");
  const version = validateVersion(config.version);
  const finalizedUntil = validateFinalizedUntil(config.finalizedUntil);
  const resolved: ResolvedCacheConfig = {
    id,
    interval,
    alignmentOffset: validateAlignmentOffset(config.alignmentOffset, interval),
    fields: validateFields(config.fields),
    gapSplitK:
      config.gapSplitK === undefined
        ? DEFAULT_GAP_SPLIT_K
        : requirePositiveSafeInteger(config.gapSplitK, "gapSplitK"),
    segmentSlotCap:
      config.segmentSlotCap === undefined
        ? DEFAULT_SEGMENT_SLOT_CAP
        : validateSegmentSlotCap(config.segmentSlotCap),
    warnOnOverlapDiff: validateWarnFlag(config.warnOnOverlapDiff),
    ...(version !== undefined ? { version } : {}),
    ...(finalizedUntil !== undefined ? { finalizedUntil } : {}),
  };
  return Object.freeze(resolved);
}
