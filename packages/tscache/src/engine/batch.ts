/**
 * Put validation (docs/architecture.md §2.4, §4.3): checks a consumer batch
 * against the cache's config and converts it to slot terms. A rejected batch
 * is rejected whole, and nothing here mutates or keeps its input.
 */

import { PutError, type PutErrorCode, show } from "../errors";
import {
  type Grid,
  isAligned,
  msOf,
  type SlotRange,
  slotOf,
  snapIn,
} from "../grid";
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

/** A %TypedArray%.prototype getter: it reads the internal slots, which no subclass can override. */
const typedArrayGetter = <T>(key: PropertyKey) =>
  Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(Uint8Array.prototype),
    key,
  )?.get as (this: unknown) => T;

/**
 * The typed-array kind of a value ("Float64Array", …), or undefined. Read
 * from the %TypedArray% tag getter, not `instanceof`, so an array made in
 * another realm (an iframe, a different worker global) is recognized too.
 */
const typedArrayKind = typedArrayGetter<string | undefined>(Symbol.toStringTag);

/** A typed array's element count, from the %TypedArray% getter as the tag. */
const typedArrayLength = typedArrayGetter<number>("length");

/**
 * The element count of a `number[]` or a typed array. A typed array's is
 * read through the %TypedArray% getter, so a subclass that overrides
 * `length` cannot make the checks and the copy disagree.
 */
function lengthOf(values: NumericArray): number {
  return Array.isArray(values) ? values.length : typedArrayLength.call(values);
}

/** A `number[]` or a typed array of numbers; BigInt arrays and DataViews are not. */
function isNumericArray(value: unknown): value is NumericArray {
  if (Array.isArray(value)) return true;
  const kind = typedArrayKind.call(value);
  return kind !== undefined && !kind.startsWith("Big");
}

function timestampsOf(batch: PutBatch): NumericArray {
  if (!isObject(batch)) {
    structural("field-mismatch", `batch must be an object, got ${show(batch)}`);
  }
  const { timestamps } = batch;
  if (
    !Array.isArray(timestamps) &&
    typedArrayKind.call(timestamps) !== "Float64Array"
  ) {
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
function assertTimestamps(
  timestamps: NumericArray,
  n: number,
  grid: Grid,
): void {
  const expected = `t ≡ ${grid.alignmentOffset} (mod ${grid.interval})`;
  for (let i = 0; i < n; i++) {
    const t = timestamps[i] as number;
    if (!isAligned(t, grid)) {
      throw new PutError(
        `timestamp ${show(t)} at index ${i} is not on the grid ${expected}`,
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

/** The rejection of the field value at index `i` (N68). */
function valueError(
  name: string,
  dtype: Dtype,
  i: number,
  slots: Float64Array,
  grid: Grid,
  value: string,
  expected: string,
): never {
  // The checked timestamp, from its slot: a getter run since cannot change it.
  const at = msOf(slots[i] as number, grid);
  throw new PutError(
    `field "${name}" (${dtype}) value ${value} at index ${i}, t = ${at}: expected ${expected}`,
    {
      code: "field-mismatch",
      offenderIndex: i,
      offenderTimestamp: at,
      offenderField: name,
      expected,
    },
  );
}

/**
 * Copies a field that may hold invalid values into `data`, a fresh array of
 * its dtype, throwing for the first value the field cannot hold (N68, §4.3):
 * a non-number in any field; in an integer field, a value that is not an
 * integer inside the dtype's range. The scan and the copy are one pass, so
 * each value is read once.
 */
function scanInto(
  data: FieldArray,
  name: string,
  dtype: Dtype,
  values: NumericArray,
  slots: Float64Array,
  grid: Grid,
): void {
  const float = dtype[0] === "f";
  // An integer dtype's inclusive range, from its element size; a float
  // dtype ("f64", "f32") holds every number.
  const half = 2 ** (data.BYTES_PER_ELEMENT * 8 - 1);
  const min = dtype[0] === "u" ? 0 : -half;
  const max = dtype[0] === "u" ? 2 * half - 1 : half - 1;
  // `data` has the batch's length, which the field's own length matched.
  for (let i = 0; i < data.length; i++) {
    const v: unknown = values[i];
    if (typeof v !== "number") {
      // show() never calls the value's own conversion; the type tells "1" from 1.
      valueError(
        name,
        dtype,
        i,
        slots,
        grid,
        show(v) + (v === null ? "" : ` (${typeof v})`),
        "a number",
      );
    }
    // An integer field takes only integers in its range (N68, decision 38):
    // a fraction fails `Number.isInteger`, as do NaN and ±Infinity,
    // and -0 passes (it is an integer).
    if (!float && !(Number.isInteger(v) && v >= min && v <= max)) {
      valueError(
        name,
        dtype,
        i,
        slots,
        grid,
        `${v}`,
        `an integer in [${min}, ${max}]`,
      );
    }
    data[i] = v;
  }
}

/** Timestamps are ascending, so only the two ends can fall outside. */
function assertInside(timestamps: NumericArray, n: number, range: Range): void {
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
 * Field values are checked (N68) and copied into fresh arrays of the
 * schema's dtypes. `meta` is not looked at here.
 */
export function validateBatch(
  batch: PutBatch,
  config: ResolvedCacheConfig,
  range?: Range,
): ValidatedBatch {
  const names = Object.keys(config.fields);
  const timestamps = timestampsOf(batch);
  const arrays = fieldArraysOf(batch, names);
  const n = lengthOf(timestamps);
  names.forEach((name, c) => {
    const length = lengthOf(arrays[c] as NumericArray);
    if (length !== n) {
      structural(
        "length-mismatch",
        `field "${name}" has ${length} values for ${n} timestamps`,
      );
    }
  });
  assertTimestamps(timestamps, n, config);
  let authority: SlotRange | undefined;
  if (range !== undefined) {
    authority = snapIn(range, config);
    assertInside(timestamps, n, range);
  }
  // Slots now, before any field array is read: a field's getter may rewrite
  // the timestamps, and the batch is converted with the ones checked above.
  const slots = new Float64Array(n);
  for (let i = 0; i < n; i++)
    slots[i] = slotOf(timestamps[i] as number, config);

  // (5) Values (N68): field by field in schema order, each copied into a
  // fresh array of its dtype before anything is kept.
  const fields: Record<string, FieldArray> = {};
  names.forEach((name, c) => {
    const dtype = config.fields[name] as Dtype;
    const values = arrays[c] as NumericArray;
    const Field = FIELD_ARRAYS[dtype];
    const data = new Field(n);
    // Anything but a number[] is a numeric typed array (fieldArraysOf), whose
    // every element is a number: a float field takes it as it is, and an
    // integer field's own storage array holds only valid values. The element
    // type is the tag (§4.3), never `constructor`, which a caller can
    // redefine; the tag also recognizes an array from another realm. Every
    // other array is scanned.
    if (
      !Array.isArray(values) &&
      (dtype[0] === "f" || typedArrayKind.call(values) === Field.name)
    ) {
      data.set(values);
    } else scanInto(data, name, dtype, values, slots, config);
    setOwn(fields, name, data);
  });
  return { points: { slots, fields }, authority };
}
