import { describe, expect, it } from "vitest";
import { InvalidRangeError } from "../src/errors";
import { isAligned, msOf, slotOf, snapOut, toMs } from "../src/grid";

// Contract: architecture §4.1, §8 N1/N9; starter §3.1.
const epochGrid = { interval: 10, alignmentOffset: 0 };
const offsetGrid = { interval: 10, alignmentOffset: 3 };

describe("grid alignment and conversion", () => {
  it.each([
    { name: "epoch origin", grid: epochGrid, timestamp: 0, slot: 0 },
    { name: "positive epoch slot", grid: epochGrid, timestamp: 20, slot: 2 },
    { name: "negative epoch slot", grid: epochGrid, timestamp: -20, slot: -2 },
    { name: "offset origin", grid: offsetGrid, timestamp: 3, slot: 0 },
    { name: "positive offset slot", grid: offsetGrid, timestamp: 23, slot: 2 },
    {
      name: "negative offset slot",
      grid: offsetGrid,
      timestamp: -17,
      slot: -2,
    },
    {
      name: "daily session-open offset",
      grid: { interval: 86_400_000, alignmentOffset: 34_200_000 },
      timestamp: 120_600_000,
      slot: 1,
    },
    {
      name: "large exact positive timestamp",
      grid: { interval: 1, alignmentOffset: 0 },
      timestamp: Number.MAX_SAFE_INTEGER,
      slot: Number.MAX_SAFE_INTEGER,
    },
    {
      name: "large exact negative timestamp",
      grid: { interval: 1, alignmentOffset: 0 },
      timestamp: -Number.MAX_SAFE_INTEGER,
      slot: -Number.MAX_SAFE_INTEGER,
    },
  ])("recognizes and converts $name", ({ grid, timestamp, slot }) => {
    expect(isAligned(timestamp, grid)).toBe(true);
    // The contract gives numeric slot values, without distinguishing -0.
    expect(slotOf(timestamp, grid) + 0).toBe(slot);
    expect(msOf(slot, grid) + 0).toBe(timestamp);
  });

  it.each([
    { name: "just below an epoch point", grid: epochGrid, timestamp: 19.999 },
    { name: "just above an epoch point", grid: epochGrid, timestamp: 20.001 },
    { name: "an integer between epoch points", grid: epochGrid, timestamp: 21 },
    {
      name: "a negative fractional timestamp",
      grid: epochGrid,
      timestamp: -0.001,
    },
    {
      name: "an epoch multiple on an offset grid",
      grid: offsetGrid,
      timestamp: 20,
    },
    { name: "just below an offset point", grid: offsetGrid, timestamp: 22.999 },
    { name: "just above an offset point", grid: offsetGrid, timestamp: 23.001 },
    { name: "a negative unaligned timestamp", grid: offsetGrid, timestamp: -8 },
    { name: "NaN", grid: epochGrid, timestamp: Number.NaN },
    {
      name: "positive infinity",
      grid: epochGrid,
      timestamp: Number.POSITIVE_INFINITY,
    },
    {
      name: "negative infinity",
      grid: epochGrid,
      timestamp: Number.NEGATIVE_INFINITY,
    },
  ])("reports $name as unaligned and slotOf throws RangeError", ({
    grid,
    timestamp,
  }) => {
    expect(isAligned(timestamp, grid)).toBe(false);
    expect(() => slotOf(timestamp, grid)).toThrow(RangeError);
  });

  it("round-trips exact aligned slots on epoch and offset grids", () => {
    for (const grid of [epochGrid, offsetGrid]) {
      for (let slot = -100; slot <= 100; slot += 1) {
        const timestamp = msOf(slot, grid);
        expect(isAligned(timestamp, grid)).toBe(true);
        expect(slotOf(timestamp, grid) + 0).toBe(slot);
      }
    }
  });
});

describe("snapOut — inclusive outward snapping", () => {
  it.each([
    {
      name: "aligned inclusive endpoints",
      grid: epochGrid,
      input: { start: 10, end: 30 },
      expected: { start: 1, end: 3 },
    },
    {
      name: "aligned start equals end",
      grid: epochGrid,
      input: { start: 20, end: 20 },
      expected: { start: 2, end: 2 },
    },
    {
      name: "unaligned start equals end",
      grid: epochGrid,
      input: { start: 21, end: 21 },
      expected: { start: 2, end: 3 },
    },
    {
      name: "equal endpoints just below a grid point",
      grid: epochGrid,
      input: { start: 19.999, end: 19.999 },
      expected: { start: 1, end: 2 },
    },
    {
      name: "equal endpoints just above a grid point",
      grid: epochGrid,
      input: { start: 20.001, end: 20.001 },
      expected: { start: 2, end: 3 },
    },
    {
      name: "start just below and end just above grid points",
      grid: epochGrid,
      input: { start: 19.999, end: 30.001 },
      expected: { start: 1, end: 4 },
    },
    {
      name: "start just above and end just below grid points",
      grid: epochGrid,
      input: { start: 20.001, end: 29.999 },
      expected: { start: 2, end: 3 },
    },
    {
      name: "aligned start and unaligned end",
      grid: epochGrid,
      input: { start: 20, end: 20.001 },
      expected: { start: 2, end: 3 },
    },
    {
      name: "unaligned start and aligned end",
      grid: epochGrid,
      input: { start: 19.999, end: 20 },
      expected: { start: 1, end: 2 },
    },
    {
      name: "an offset single slot",
      grid: offsetGrid,
      input: { start: 23, end: 23 },
      expected: { start: 2, end: 2 },
    },
    {
      name: "an offset inclusive span",
      grid: offsetGrid,
      input: { start: 13, end: 33 },
      expected: { start: 1, end: 3 },
    },
    {
      name: "just below an offset point",
      grid: offsetGrid,
      input: { start: 22.999, end: 22.999 },
      expected: { start: 1, end: 2 },
    },
    {
      name: "just above an offset point",
      grid: offsetGrid,
      input: { start: 23.001, end: 23.001 },
      expected: { start: 2, end: 3 },
    },
    {
      name: "negative aligned slots",
      grid: offsetGrid,
      input: { start: -17, end: -7 },
      expected: { start: -2, end: -1 },
    },
    {
      name: "negative unaligned endpoints",
      grid: offsetGrid,
      input: { start: -17.001, end: -6.999 },
      expected: { start: -3, end: 0 },
    },
    {
      name: "a negative equal endpoint",
      grid: epochGrid,
      input: { start: -0.001, end: -0.001 },
      expected: { start: -1, end: 0 },
    },
    {
      name: "a span across the offset origin",
      grid: offsetGrid,
      input: { start: 2.999, end: 3.001 },
      expected: { start: -1, end: 1 },
    },
  ])("snaps $name", ({ grid, input, expected }) => {
    const actual = snapOut(input, grid);
    expect(actual.start + 0).toBe(expected.start);
    expect(actual.end + 0).toBe(expected.end);
  });

  it.each([
    { name: "NaN start", input: { start: Number.NaN, end: 20 } },
    { name: "NaN end", input: { start: 10, end: Number.NaN } },
    {
      name: "positive infinite start",
      input: { start: Number.POSITIVE_INFINITY, end: 20 },
    },
    {
      name: "negative infinite start",
      input: { start: Number.NEGATIVE_INFINITY, end: 20 },
    },
    {
      name: "positive infinite end",
      input: { start: 10, end: Number.POSITIVE_INFINITY },
    },
    {
      name: "negative infinite end",
      input: { start: 10, end: Number.NEGATIVE_INFINITY },
    },
    { name: "inverted aligned endpoints", input: { start: 30, end: 20 } },
    {
      name: "inverted endpoints that would snap to the same span",
      input: { start: 20.002, end: 20.001 },
    },
  ])("rejects $name with InvalidRangeError", ({ input }) => {
    for (const grid of [epochGrid, offsetGrid]) {
      expect(() => snapOut(input, grid)).toThrow(InvalidRangeError);
    }
  });

  it("returns the smallest enclosing grid span and is idempotent after toMs", () => {
    for (const grid of [epochGrid, offsetGrid]) {
      for (let start = -25; start <= 25; start += 0.5) {
        for (const width of [0, 0.25, 10, 23.5]) {
          const input = { start, end: start + width };
          const slots = snapOut(input, grid);
          const enclosing = toMs(slots, grid);
          expect(enclosing.start).toBeLessThanOrEqual(input.start);
          expect(enclosing.end).toBeGreaterThanOrEqual(input.end);
          expect(msOf(slots.start + 1, grid)).toBeGreaterThan(input.start);
          expect(msOf(slots.end - 1, grid)).toBeLessThan(input.end);
          const again = snapOut(enclosing, grid);
          expect(again.start + 0).toBe(slots.start + 0);
          expect(again.end + 0).toBe(slots.end + 0);
        }
      }
    }
  });
});

describe("toMs — inclusive slot range conversion", () => {
  it.each([
    {
      name: "an epoch span",
      grid: epochGrid,
      slots: { start: 1, end: 3 },
      expected: { start: 10, end: 30 },
    },
    {
      name: "an epoch single slot",
      grid: epochGrid,
      slots: { start: 2, end: 2 },
      expected: { start: 20, end: 20 },
    },
    {
      name: "an offset span",
      grid: offsetGrid,
      slots: { start: 1, end: 3 },
      expected: { start: 13, end: 33 },
    },
    {
      name: "the offset origin",
      grid: offsetGrid,
      slots: { start: 0, end: 0 },
      expected: { start: 3, end: 3 },
    },
    {
      name: "negative offset slots",
      grid: offsetGrid,
      slots: { start: -3, end: -1 },
      expected: { start: -27, end: -7 },
    },
    {
      name: "a span across zero",
      grid: epochGrid,
      slots: { start: -1, end: 1 },
      expected: { start: -10, end: 10 },
    },
  ])("converts $name without changing the inclusive ends", ({
    grid,
    slots,
    expected,
  }) => {
    expect(toMs(slots, grid)).toEqual(expected);
  });
});
