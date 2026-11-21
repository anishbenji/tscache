import { expect, it } from "vitest";
import {
  batch,
  DAY,
  engine,
  HOUR,
  ID,
  NY,
  probe,
  slots,
  span,
} from "./calendar-contract-helpers";

// Implementer tests added after Codex round 1 of step 129
// (docs/reviews/step-129.md, R1-2).

const daily = { unit: "day", zone: NY, at: "09:30" } as const;
const winter = () => -5 * HOUR;
const dailyStart = (slot: number) => slot * DAY + 14.5 * HOUR;
const BLOCK = 512;

// R1-2 (N124): no conversion makes more than two resolutions for each
// start it needs, wherever its slots lie and however few tables are held.
// With a constant offset a resolution is two lookups.
it.each([
  { name: "put", capacity: 2 },
  { name: "get", capacity: 2 },
  { name: "put", capacity: 1 },
  { name: "get", capacity: 1 },
])(
  "R1-2: a $name of 8 whole blocks with $capacity tables makes about one resolution for each start",
  ({ name, capacity }) => {
    const first = 40 * BLOCK;
    const starts = 8 * BLOCK;
    const timestamps = slots(first, first + starts - 1).map(dailyStart);
    const { context, lookups } = probe(winter, { tableCapacity: capacity });
    const e = engine(daily, {}, context);
    if (name === "get") {
      e.put(ID, batch(timestamps));
      lookups.length = 0;
      const read = e.get(ID, span(timestamps[0] as number, timestamps.at(-1)));
      expect(read.timestamps).toEqual(new Float64Array(timestamps));
    } else {
      e.put(ID, batch(timestamps));
    }
    const resolutions = lookups.length / 2;
    // The bound of N124...
    expect(resolutions).toBeLessThanOrEqual(2 * starts);
    // ...and what the fill rule gives when each table is used before a
    // later fill can evict it: one resolution a slot and one more a table,
    // and a few lone starts at the range's ends and the blocks' edges.
    expect(resolutions).toBeLessThanOrEqual(starts + 8 + 64);
    expect(context.tableCount).toBe(capacity);
  },
);

it("R1-2: a batch that is rejected part-way converts no further", () => {
  const first = 40 * BLOCK;
  const timestamps = slots(first, first + 4 * BLOCK - 1).map(dailyStart);
  timestamps[BLOCK + 5] = (timestamps[BLOCK + 5] as number) + 1;
  const { context, lookups } = probe(winter, { tableCapacity: 2 });
  const e = engine(daily, {}, context);
  expect(() => e.put(ID, batch(timestamps))).toThrow(
    expect.objectContaining({ code: "misaligned", offenderIndex: BLOCK + 5 }),
  );
  // Two blocks' tables at most: the blocks after the offender are not filled.
  expect(lookups.length / 2).toBeLessThanOrEqual(2 * 513 + 16);
});
