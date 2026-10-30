// Runs under Vitest, not Playwright: the examples project matches only
// *.spec.ts, and the chromium project ignores this directory.

import { describe, expect, it } from "vitest";
import { portOffset } from "./apps";

const root = "/work/tscache";

describe("portOffset", () => {
  it("uses no offset in CI, whatever else is set", () => {
    expect(portOffset({ CI: "true" }, root)).toBe(0);
    expect(portOffset({ CI: "1", E2E_PORT_OFFSET: "7" }, root)).toBe(0);
    expect(portOffset({ CI: "true", E2E_PORT_OFFSET: "nope" }, root)).toBe(0);
  });

  it("takes an override from 0 to 39 thousand", () => {
    expect(portOffset({ E2E_PORT_OFFSET: "0" }, root)).toBe(0);
    expect(portOffset({ E2E_PORT_OFFSET: "1" }, root)).toBe(1000);
    expect(portOffset({ E2E_PORT_OFFSET: "39" }, root)).toBe(39_000);
  });

  it.each(["40", "-1", "1.5", "abc", " ", "1e3", "0x1", "+1", "1 "])(
    "rejects the override %j",
    (value) => {
      expect(() => portOffset({ E2E_PORT_OFFSET: value }, root)).toThrow(
        RangeError,
      );
    },
  );

  it("hashes the checkout's path when no override is set or it is empty", () => {
    const unset = portOffset({}, root);
    expect(portOffset({ E2E_PORT_OFFSET: "" }, root)).toBe(unset);
    expect(portOffset({}, root)).toBe(unset);
  });

  it("gives every checkout a nonzero offset below the ephemeral range", () => {
    const offsets = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const offset = portOffset({}, `/work/checkout-${i}`);
      expect(offset % 1000).toBe(0);
      expect(offset).toBeGreaterThanOrEqual(1000);
      expect(offset).toBeLessThanOrEqual(39_000);
      offsets.add(offset);
    }
    // Every step is reachable, so checkouts spread over all 39.
    expect(offsets.size).toBe(39);
  });
});
