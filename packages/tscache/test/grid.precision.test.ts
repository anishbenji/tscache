import { describe, expect, it } from "vitest";
import { InvalidRangeError } from "../src/errors";
import { isAligned, msOf, slotOf, snapOut, toMs } from "../src/grid";

// Implementer tests (not contract tests): exactness near ±2^53, where the
// literal formula (t - alignmentOffset) % interval leaves exact-integer range.
const MAX = Number.MAX_SAFE_INTEGER;

describe("grid arithmetic stays exact near ±2^53", () => {
  it("classifies alignment exactly when t - alignmentOffset is not a safe integer", () => {
    const grid = { interval: 3, alignmentOffset: 2 };
    // -MAX - 2 = -(2^53 + 1) is a multiple of 3, but is not representable.
    expect(isAligned(-MAX, grid)).toBe(true);
    expect(isAligned(-MAX + 1, grid)).toBe(false);
    expect(isAligned(-MAX + 3, grid)).toBe(true);
    expect(slotOf(-MAX + 3, grid)).toBe((-MAX + 3 - 2) / 3);
  });

  it("maps a negative slot back to its exact timestamp", () => {
    const grid = { interval: 3, alignmentOffset: 2 };
    expect(msOf(slotOf(-MAX, grid), grid)).toBe(-MAX);
    const enclosing = toMs(snapOut({ start: -MAX, end: -MAX }, grid), grid);
    expect(enclosing).toEqual({ start: -MAX, end: -MAX });
  });

  it("agrees with BigInt arithmetic across intervals and offsets at both extremes", () => {
    for (const interval of [1, 2, 3, 7, 60_000, 86_400_000]) {
      for (const alignmentOffset of [0, 1, interval - 1]) {
        if (alignmentOffset >= interval) continue;
        const grid = { interval, alignmentOffset };
        for (const base of [-MAX, -MAX + 1_000, MAX - 1_000]) {
          for (let d = 0; d < 20; d++) {
            const t = base + d;
            const diff = BigInt(t) - BigInt(alignmentOffset);
            const aligned = diff % BigInt(interval) === 0n;
            expect(isAligned(t, grid)).toBe(aligned);
            // Round trip: slot * interval alone may leave exact range.
            if (aligned) expect(msOf(slotOf(t, grid), grid)).toBe(t);
            // floor division on BigInt (which truncates toward zero)
            const q = diff / BigInt(interval);
            const floor = !aligned && diff < 0n ? q - 1n : q;
            const ceil = aligned ? floor : floor + 1n;
            const ms = (slot: bigint) =>
              slot * BigInt(interval) + BigInt(alignmentOffset);
            const snap = () => snapOut({ start: t, end: t }, grid);
            if (ms(floor) < -BigInt(MAX) || ms(ceil) > BigInt(MAX)) {
              // The outward snap leaves the supported range.
              expect(snap).toThrow(InvalidRangeError);
            } else {
              expect(BigInt(snap().start)).toBe(floor);
              expect(BigInt(snap().end)).toBe(ceil);
            }
          }
        }
      }
    }
  });
});
