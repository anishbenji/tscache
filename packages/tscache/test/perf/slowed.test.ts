import { describe, expect, it } from "vitest";
import { slowed } from "../../bench/run";

// How calibration makes the head slower (docs/benchmarking.md, "Calibration
// before the timing gate blocks"): a short operation, or one whose case
// asks for repetition, runs again that often; a long one waits. On a
// virtual clock, as the sampler's tests use, so no real time is measured.

/**
 * An operation that takes `ms` on a clock that also moves 0.01 ms on every
 * read, so a wait on it ends.
 */
function counting(ms: number) {
  let now = 0;
  let calls = 0;
  const clock = () => {
    now += 0.01;
    return now;
  };
  const op = () => {
    calls++;
    now += ms;
    return 1;
  };
  return { op, clock, calls: () => calls, now: () => now };
}

describe("an injected slowdown", () => {
  it("runs a short operation again that fraction of the time", () => {
    const { op, clock, calls } = counting(0.1);
    const slow = slowed(op, 0.25, { clock });
    const warm = calls();
    for (let i = 0; i < 400; i++) slow();
    expect(calls() - warm).toBe(500);
  });

  it("makes an operation of 2 ms or more wait that fraction of its time", () => {
    const { op, clock, calls, now } = counting(2.5);
    const slow = slowed(op, 0.25, { clock });
    const [warm, start] = [calls(), now()];
    for (let i = 0; i < 8; i++) slow();
    expect(calls() - warm).toBe(8);
    expect(now() - start).toBeGreaterThanOrEqual(8 * 2.5 * 1.25);
  });

  it("runs a long operation again instead when its case asks for repetition", () => {
    const { op, clock, calls } = counting(2.5);
    const slow = slowed(op, 0.25, { clock, by: "repeat" });
    const warm = calls();
    for (let i = 0; i < 8; i++) slow();
    expect(calls() - warm).toBe(10);
  });
});
