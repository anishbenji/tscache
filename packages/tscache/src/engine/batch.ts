/**
 * Put validation (docs/architecture.md §2.4, §4.3): checks a consumer batch
 * against the cache's config and converts it to slot terms. A rejected batch
 * is rejected whole, and nothing here mutates or keeps its input.
 */

import { PutError, type PutErrorCode } from "../errors";
import { type Grid, isAligned, type SlotRange, slotOf, snapIn } from "../grid";
import { FIELD_ARRAYS } from "../segment/dtype";
import { getOwn, setOwn } from "../segment/own";
import type { Columns } from "../segment/types";
import type {
  Dtype,
  FieldArray,
  PutBatch,
  Range,
  ResolvedCacheConfig,
} from "../types";

/** A validated batch in slot terms. */
export interface ValidatedBatch {
  points: Columns;
  /**
   * The inward snap of the put's range (N13); undefined when no range was
   * given or the range holds no grid point.
   */
  authority: SlotRange | undefined;
}

type NumericArray = ArrayLike<number>;

/** Structural rejects have no offending timestamp. */
function structural(code: PutErrorCode, message: string): never {
  throw new PutError(message, { code, offenderIndex: -1 });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A `number[]` or a typed array of numbers; BigInt arrays and DataViews are not. */
function isNumericArray(value: unknown): value is NumericArray {
  if (Array.isArray(value)) return true;
  return (
    ArrayBuffer.isView(value) &&
    !(value instanceof DataView) &&
    !(value instanceof BigInt64Array) &&
    !(value instanceof BigUint64Array)
  );
}

function timestampsOf(batch: PutBatch): NumericArray {
  if (!isObject(batch)) {
    structural("field-mismatch", `batch must be an object, got ${batch}`);
  }
  const { timestamps } = batch;
  if (!Array.isArray(timestamps) && !(timestamps instanceof Float64Array)) {
    structural(
      "field-mismatch",
      "batch timestamps must be a number[] or a Float64Array",
    );
  }
  return timestamps;
}

/** The batch's field arrays in schema order; names must match the schema exactly. */
function fieldArraysOf(batch: PutBatch, names: string[]): NumericArray[] {
  const { fields } = batch;
  if (!isObject(fields)) {
    structural("field-mismatch", "batch fields must be an object");
  }
  const given = Object.keys(fields);
  const extra = given.find((name) => !names.includes(name));
  if (extra !== undefined) {
    structural("field-mismatch", `field "${extra}" is not in the schema`);
  }
  return names.map((name) => {
    const values = getOwn(fields, name);
    if (values === undefined) {
      structural("field-mismatch", `field "${name}" is missing`);
    }
    if (!isNumericArray(values)) {
      structural(
        "field-mismatch",
        `field "${name}" must be a number[] or a typed array of numbers`,
      );
    }
    return values;
  });
}

/** Scans once and throws for the first timestamp that breaks a rule. */
function assertTimestamps(timestamps: NumericArray, grid: Grid): void {
  const expected = `t ≡ ${grid.alignmentOffset} (mod ${grid.interval})`;
  for (let i = 0; i < timestamps.length; i++) {
    const t = timestamps[i] as number;
    if (!isAligned(t, grid)) {
      throw new PutError(
        `timestamp ${String(t)} at index ${i} is not on the grid ${expected}`,
        {
          code: "misaligned",
          offenderIndex: i,
          // A non-number offender has no numeric value to report.
          ...(typeof t === "number" ? { offenderTimestamp: t } : {}),
          expected,
        },
      );
    }
    if (i === 0) continue;
    const previous = timestamps[i - 1] as number;
    if (t > previous) continue;
    const code = t === previous ? "duplicate" : "unsorted";
    throw new PutError(
      `timestamp ${t} at index ${i} ${code === "duplicate" ? "repeats" : "is below"} its predecessor ${previous}`,
      {
        code,
        offenderIndex: i,
        offenderTimestamp: t,
        expected: "timestamps strictly ascending",
      },
    );
  }
}

/** Timestamps are ascending, so only the two ends can fall outside. */
function assertInside(timestamps: NumericArray, range: Range): void {
  const n = timestamps.length;
  if (n === 0) return;
  const first = timestamps[0] as number;
  const last = timestamps[n - 1] as number;
  let i = -1;
  if (first < range.start) i = 0;
  else if (last > range.end) {
    // First timestamp past the end.
    i = n - 1;
    while (i > 0 && (timestamps[i - 1] as number) > range.end) i--;
  }
  if (i === -1) return;
  throw new PutError(
    `timestamp ${timestamps[i]} at index ${i} is outside the put range [${range.start}, ${range.end}]`,
    {
      code: "range-mismatch",
      offenderIndex: i,
      offenderTimestamp: timestamps[i] as number,
      expected: `${range.start} <= t <= ${range.end}`,
    },
  );
}

/**
 * Validates a consumer batch and converts it to slot terms. Throws PutError
 * naming the first offender, or InvalidRangeError for a malformed range.
 * Field values are copied into fresh arrays of the schema's dtypes by
 * typed-array assignment. `meta` is not looked at here.
 */
export function validateBatch(
  batch: PutBatch,
  config: ResolvedCacheConfig,
  range?: Range,
): ValidatedBatch {
  const names = Object.keys(config.fields);
  const timestamps = timestampsOf(batch);
  const arrays = fieldArraysOf(batch, names);
  const n = timestamps.length;
  names.forEach((name, c) => {
    const length = (arrays[c] as NumericArray).length;
    if (length !== n) {
      structural(
        "length-mismatch",
        `field "${name}" has ${length} values for ${n} timestamps`,
      );
    }
  });
  assertTimestamps(timestamps, config);
  let authority: SlotRange | undefined;
  if (range !== undefined) {
    authority = snapIn(range, config);
    assertInside(timestamps, range);
  }

  const slots = new Float64Array(n);
  for (let i = 0; i < n; i++)
    slots[i] = slotOf(timestamps[i] as number, config);
  const fields: Record<string, FieldArray> = {};
  names.forEach((name, c) => {
    const data = new FIELD_ARRAYS[config.fields[name] as Dtype](n);
    data.set(arrays[c] as NumericArray);
    setOwn(fields, name, data);
  });
  return { points: { slots, fields }, authority };
}
