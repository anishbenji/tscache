import { describe, expect, it } from "vitest";
import { InvalidRangeError } from "../src/errors";
import { type Grid, slotAtOrAfter } from "../src/grid";

describe("slotAtOrAfter — architecture §4.1, §4.5", () => {
  it.each([
    { t: 0, slot: 0 },
    { t: 20, slot: 2 },
    { t: 20.25, slot: 3 },
    { t: 19.75, slot: 2 },
    { t: -20, slot: -2 },
    { t: -20.25, slot: -2 },
    { t: -19.75, slot: -1 },
    { t: -0.25, slot: 0 },
  ])("ceils $t on an epoch grid to slot $slot", ({ t, slot }) => {
    expect(slotAtOrAfter(t, { interval: 10, alignmentOffset: 0 })).toBe(slot);
  });

  it.each([
    { t: 3, slot: 0 },
    { t: 13, slot: 1 },
    { t: 13.25, slot: 2 },
    { t: 12.75, slot: 1 },
    { t: -17, slot: -2 },
    { t: -17.25, slot: -2 },
    { t: -16.75, slot: -1 },
    { t: 0, slot: 0 },
    { t: -7, slot: -1 },
  ])("ceils $t on an offset grid to slot $slot", ({ t, slot }) => {
    expect(slotAtOrAfter(t, { interval: 10, alignmentOffset: 3 })).toBe(slot);
  });

  it.each([Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER])(
    "accepts the safe timestamp boundary %i on a unit grid",
    (t) => {
      expect(slotAtOrAfter(t, { interval: 1, alignmentOffset: 0 })).toBe(t);
    },
  );

  it("accepts a negative boundary even when timestamp minus offset is outside the safe domain", () => {
    const g: Grid = { interval: 3, alignmentOffset: 2 };
    expect(slotAtOrAfter(Number.MIN_SAFE_INTEGER, g)).toBe(
      -3_002_399_751_580_331,
    );
    expect(slotAtOrAfter(Number.MIN_SAFE_INTEGER + 1, g)).toBe(
      -3_002_399_751_580_330,
    );
  });

  it("rejects a finite in-domain timestamp whose next grid point is out of bounds", () => {
    const g: Grid = { interval: 2, alignmentOffset: 0 };
    expect(slotAtOrAfter(Number.MAX_SAFE_INTEGER - 1, g)).toBe(
      4_503_599_627_370_495,
    );
    expect(() => slotAtOrAfter(Number.MAX_SAFE_INTEGER, g)).toThrow(
      InvalidRangeError,
    );
    // The lower boundary needs only a ceil: no floor point is required.
    expect(slotAtOrAfter(Number.MIN_SAFE_INTEGER, g)).toBe(
      -4_503_599_627_370_495,
    );
  });

  it("matches an exact BigInt oracle near both bounds across offset grids", () => {
    const max = Number.MAX_SAFE_INTEGER;
    for (const interval of [1, 2, 3, 7, 60_000]) {
      for (const alignmentOffset of new Set([0, interval - 1])) {
        const g: Grid = { interval, alignmentOffset };
        for (const base of [-max, max - 20]) {
          for (let d = 0; d <= 20; d += 1) {
            const t = base + d;
            const delta = BigInt(t) - BigInt(alignmentOffset);
            const step = BigInt(interval);
            const ceil =
              delta / step + (delta > 0n && delta % step !== 0n ? 1n : 0n);
            const ms = ceil * step + BigInt(alignmentOffset);
            if (ms > BigInt(max) || ms < -BigInt(max)) {
              expect(() => slotAtOrAfter(t, g)).toThrow(InvalidRangeError);
            } else {
              expect(BigInt(slotAtOrAfter(t, g))).toBe(ceil);
            }
          }
        }
      }
    }
  });

  it.each([
    Number.NaN,
    Infinity,
    -Infinity,
    2 ** 53,
    -(2 ** 53),
    undefined,
    null,
    "13",
    true,
    {},
    Symbol("t"),
  ])("rejects unsupported watermark %j with InvalidRangeError", (t) => {
    expect(() =>
      slotAtOrAfter(t as number, { interval: 10, alignmentOffset: 3 }),
    ).toThrow(InvalidRangeError);
  });
});
