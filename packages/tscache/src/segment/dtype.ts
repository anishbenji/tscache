import type { Dtype, FieldArray } from "../types";

/** The construct signatures every field array shares. */
export interface FieldArrayConstructor {
  new (length: number): FieldArray;
  new (buffer: ArrayBuffer): FieldArray;
  readonly BYTES_PER_ELEMENT: number;
}

/** Storage type per dtype (N7). */
export const FIELD_ARRAYS: Readonly<Record<Dtype, FieldArrayConstructor>> = {
  f64: Float64Array,
  f32: Float32Array,
  i32: Int32Array,
  u32: Uint32Array,
  i16: Int16Array,
  u16: Uint16Array,
  i8: Int8Array,
  u8: Uint8Array,
};
