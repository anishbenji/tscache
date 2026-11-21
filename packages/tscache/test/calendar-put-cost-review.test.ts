import { expect, it } from "vitest";
import {
  batch,
  DAY,
  engine,
  HOUR,
  ID,
  probe,
  slots,
} from "./calendar-contract-helpers";

// Implementer tests added after the pre-review before Codex round 2 of
// step 129 (docs/reviews/step-129.md, PR3-1).

const BLOCK = 512;

// N124 as §4.1 states it for a put: a timestamp needs the start of each
// slot its floor visits, and v starts computed alone cost v + 1
// resolutions, never more than two a start. With a constant offset a
// resolution is two lookups.
const zones = [
  {
    // The candidate, the slot of the timestamp's UTC date, is its slot: one
    // start is needed, two resolutions.
    name: "New York at 09:30",
    interval: { unit: "day", zone: "America/New_York", at: "09:30" },
    offset: -5 * HOUR,
    start: (slot: number) => slot * DAY + 14.5 * HOUR,
    needed: 1,
  },
  {
    // A slot starts at 18:00 UTC of the day before, so the candidate is one
    // below it: two starts are needed, three resolutions.
    name: "Tokyo at 03:00",
    interval: { unit: "day", zone: "Asia/Tokyo", at: "03:00" },
    offset: 9 * HOUR,
    start: (slot: number) => slot * DAY - 6 * HOUR,
    needed: 2,
  },
] as const;

const cases = zones.flatMap((zone) =>
  [20, 0].flatMap((first) =>
    [1, 100, 256, 257].map((count) => ({ ...zone, first, count })),
  ),
);

it.each(cases)(
  "17: a put of $count timestamps from slot $first of a block in $name makes at most one resolution more than the starts it needs",
  ({ interval, offset, start, needed, first, count }) => {
    const { context, lookups } = probe(() => offset);
    const e = engine(interval, {}, context);
    const from = 40 * BLOCK + first;
    const timestamps = slots(from, from + count - 1).map(start);
    e.put(ID, batch(timestamps));
    const resolutions = lookups.length / 2;
    // Alone, each timestamp's starts cost one resolution more than their
    // number; a table that is filled costs less.
    expect(resolutions).toBeLessThanOrEqual((needed + 1) * count);
    // N124: never more than two resolutions for a start the put needs.
    expect(resolutions).toBeLessThanOrEqual(2 * needed * count);
    // The fill rule's edge: more than half of a block, counted by candidate.
    const candidates = needed === 1 ? count : first === 0 ? count - 1 : count;
    expect(context.tableCount).toBe(candidates > BLOCK / 2 ? 1 : 0);
    // Stored where they were put.
    expect(
      e.get(ID, {
        start: timestamps[0] as number,
        end: timestamps.at(-1) as number,
      }).timestamps,
    ).toEqual(new Float64Array(timestamps));
  },
);
