/**
 * Coverage index: which slots are authoritative ("we asked; the answer is
 * final"), kept apart from the data so that a covered slot without a point is
 * a confirmed real gap (starter §3.2). Contract: docs/architecture.md §4.1.
 *
 * A sorted array of disjoint, non-adjacent inclusive slot ranges with binary
 * search. Ranges merge aggressively and real gaps never split coverage, so n
 * stays in the tens; the rejected alternatives are in architecture §6.1.
 */

import type { SlotRange } from "./grid";

/**
 * Malformed ranges are programming errors: consumer input is validated in
 * grid.ts. Requiring safe integers keeps every `± 1` below exact.
 */
function assertSlotRange(r: SlotRange): void {
  if (!Number.isSafeInteger(r.start) || !Number.isSafeInteger(r.end)) {
    throw new RangeError(
      `slot range endpoints must be safe integers, got [${r.start}, ${r.end}]`,
    );
  }
  if (r.start > r.end) {
    throw new RangeError(
      `slot range start ${r.start} is after its end ${r.end}`,
    );
  }
}

export class CoverageIndex {
  /** Sorted ascending; disjoint; no two adjacent. */
  readonly #ranges: SlotRange[] = [];

  /** Index of the first range whose end is >= slot (ranges.length if none). */
  #firstEndingAtOrAfter(slot: number): number {
    let lo = 0;
    let hi = this.#ranges.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((this.#ranges[mid] as SlotRange).end < slot) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Records `r` as authoritative. Overlapping and adjacent ranges merge:
   * with inclusive integer ends, `a.end + 1 === b.start` leaves no slot
   * between them.
   */
  add(r: SlotRange): void {
    assertSlotRange(r);
    const first = this.#firstEndingAtOrAfter(r.start - 1);
    let { start, end } = r;
    let next = first;
    for (; next < this.#ranges.length; next++) {
      const existing = this.#ranges[next] as SlotRange;
      if (existing.start > end + 1) break;
      start = Math.min(start, existing.start);
      end = Math.max(end, existing.end);
    }
    this.#ranges.splice(first, next - first, { start, end });
  }

  /** Forgets `r` (invalidate). May split one range into two. */
  subtract(r: SlotRange): void {
    assertSlotRange(r);
    const first = this.#firstEndingAtOrAfter(r.start);
    const kept: SlotRange[] = [];
    let next = first;
    for (; next < this.#ranges.length; next++) {
      const existing = this.#ranges[next] as SlotRange;
      if (existing.start > r.end) break;
      if (existing.start < r.start) {
        kept.push({ start: existing.start, end: r.start - 1 });
      }
      if (existing.end > r.end) {
        kept.push({ start: r.end + 1, end: existing.end });
      }
    }
    this.#ranges.splice(first, next - first, ...kept);
  }

  /** Covered sub-ranges of `r`, ascending, each clipped to `r`. */
  covered(r: SlotRange): SlotRange[] {
    assertSlotRange(r);
    const out: SlotRange[] = [];
    for (
      let i = this.#firstEndingAtOrAfter(r.start);
      i < this.#ranges.length;
      i++
    ) {
      const existing = this.#ranges[i] as SlotRange;
      if (existing.start > r.end) break;
      out.push({
        start: Math.max(existing.start, r.start),
        end: Math.min(existing.end, r.end),
      });
    }
    return out;
  }

  /**
   * Uncovered sub-ranges of `r`, ascending, each clipped to `r`. Together
   * with covered(r) they tile `r` exactly; these become the read's misses.
   */
  gaps(r: SlotRange): SlotRange[] {
    const out: SlotRange[] = [];
    let cursor = r.start;
    for (const c of this.covered(r)) {
      if (c.start > cursor) out.push({ start: cursor, end: c.start - 1 });
      cursor = c.end + 1;
    }
    if (cursor <= r.end) out.push({ start: cursor, end: r.end });
    return out;
  }

  /** Copy of the index; mutating the result does not affect it. */
  ranges(): SlotRange[] {
    return this.#ranges.map((r) => ({ ...r }));
  }

  clear(): void {
    this.#ranges.length = 0;
  }
}
