import { describe, expect, it } from "vitest";
import { chartKindOf } from "../src/chart/load";
import { keptRange, moved } from "../src/chart/view";
import {
  formingBar,
  MINUTE,
  market,
  openingRange,
  readRange,
} from "../src/market";

const NOW = Date.UTC(2026, 9, 26, 12, 0, 30);

describe("readRange", () => {
  // NOW lies 30 s into the bar that opened at FORMING.
  const FORMING = NOW - 30_000;

  it("reads a screen more on each side, never past the bar forming now", () => {
    const visible = { start: NOW - 60 * MINUTE, end: NOW - 30 * MINUTE };
    expect(readRange(visible, NOW)).toEqual({
      start: NOW - 90 * MINUTE,
      end: FORMING,
    });
    const history = { start: NOW - 600 * MINUTE, end: NOW - 500 * MINUTE };
    expect(readRange(history, NOW)).toEqual({
      start: NOW - 700 * MINUTE,
      end: NOW - 400 * MINUTE,
    });
  });

  it("ends on the grid whenever it reaches now", () => {
    // An end between grid points snaps outward to the next one, a bar that
    // cannot exist yet; a read crossing a minute boundary then fetches
    // three minutes (fix 26). Every end that reaches now is a bar's start.
    for (const now of [FORMING, FORMING + 1, NOW, FORMING + MINUTE - 1]) {
      const range = readRange(openingRange(now), now);
      expect(range.end).toBe(FORMING);
    }
  });

  it("stays a valid range when the view is past now", () => {
    const future = { start: NOW + 60 * MINUTE, end: NOW + 120 * MINUTE };
    const range = readRange(future, NOW);
    expect(range.start).toBeLessThanOrEqual(range.end);
    expect(range.end).toBe(FORMING);
  });

  it("opens on the last six hours", () => {
    expect(openingRange(NOW)).toEqual({ start: NOW - 360 * MINUTE, end: NOW });
  });
});

describe("formingBar", () => {
  it("is the start of the bar forming at a time, on the market's grid", () => {
    expect(formingBar(NOW)).toBe(NOW - 30_000);
    expect(formingBar(NOW - 30_000)).toBe(NOW - 30_000);
    expect(formingBar(NOW + 29_999)).toBe(NOW - 30_000);
    expect(formingBar(NOW + 30_000)).toBe(NOW + 30_000);
  });

  it("honours the grid's alignment offset", () => {
    const config = { ...market, alignmentOffset: 15_000 };
    expect(formingBar(NOW, config)).toBe(NOW - 15_000);
    expect(formingBar(NOW - 16_000, config)).toBe(NOW - 75_000);
  });
});

describe("keptRange", () => {
  const shown = { start: 1000, end: 2000 };

  it("follows the newest bar while the view shows it", () => {
    expect(keptRange(shown, 1900, 1960)).toEqual({ start: 1060, end: 2060 });
  });

  it("stays put while the view is in history", () => {
    expect(keptRange(shown, 2500, 2560)).toEqual(shown);
  });
});

describe("moved", () => {
  it("ignores a change within half an interval", () => {
    const range = { start: 0, end: 10 * MINUTE };
    expect(moved(undefined, range, MINUTE)).toBe(true);
    expect(moved(range, { start: 20_000, end: 10 * MINUTE }, MINUTE)).toBe(
      false,
    );
    expect(moved(range, { start: 40_000, end: 10 * MINUTE }, MINUTE)).toBe(
      true,
    );
  });
});

describe("chartKindOf", () => {
  it("takes ?chart=, defaulting to Lightweight Charts", () => {
    expect(chartKindOf("?chart=uplot")).toBe("uplot");
    expect(chartKindOf("?chart=other")).toBe("lightweight");
    expect(chartKindOf("")).toBe("lightweight");
  });
});
