/**
 * Checks for programming errors in slot-term input (architecture §4.2). None
 * is reachable from consumer input, which put validation rejects first, so
 * they throw RangeError. Shared by the segment and the merge path, which must
 * reject the same input before either mutates anything.
 */

import type { SlotRange } from "../grid";
import { getOwn } from "./own";
import type { Columns } from "./types";

export function assertSlot(slot: number, what: string): void {
  if (!Number.isSafeInteger(slot)) {
    throw new RangeError(`${what} must be a safe integer, got ${slot}`);
  }
}

export function assertSlotRange(r: SlotRange, what: string): void {
  assertSlot(r.start, `${what} start`);
  assertSlot(r.end, `${what} end`);
  if (r.start > r.end) {
    throw new RangeError(`${what} start ${r.start} is after its end ${r.end}`);
  }
}

function assertAscending(slots: Float64Array): void {
  let previous = Number.NEGATIVE_INFINITY;
  for (const slot of slots) {
    assertSlot(slot, "point slot");
    if (slot <= previous) {
      throw new RangeError(
        `point slots must be strictly ascending, got ${slot} after ${previous}`,
      );
    }
    previous = slot;
  }
}

/** The batch must carry exactly the schema's fields, one value per slot. */
function assertFields(points: Columns, names: readonly string[]): void {
  const { slots, fields } = points;
  // Enumerable own names only: the same set a spread or a structured
  // clone of the batch would carry.
  const given = new Set(Object.keys(fields));
  if (given.size !== names.length) {
    throw new RangeError("point fields must be exactly the schema's fields");
  }
  for (const name of names) {
    const values = given.has(name) ? getOwn(fields, name) : undefined;
    if (values === undefined || values.length !== slots.length) {
      throw new RangeError(
        `point field "${name}" must hold ${slots.length} values`,
      );
    }
  }
}

/**
 * Rejects malformed points or authority: slots that are not strictly
 * ascending safe integers, fields that are not exactly the schema's `names`
 * with one value per slot, or a point outside `authority`.
 */
export function assertPoints(
  points: Columns,
  names: readonly string[],
  authority: SlotRange | undefined,
): void {
  if (authority !== undefined) assertSlotRange(authority, "authority");
  const { slots } = points;
  assertAscending(slots);
  assertFields(points, names);
  if (authority === undefined || slots.length === 0) return;
  const first = slots[0] as number;
  const last = slots[slots.length - 1] as number;
  if (first < authority.start || last > authority.end) {
    throw new RangeError(
      `points [${first}, ${last}] lie outside the authority [${authority.start}, ${authority.end}]`,
    );
  }
}
