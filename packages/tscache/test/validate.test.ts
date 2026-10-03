import { describe, expect, it } from "vitest";
import {
  DEFAULT_GAP_SPLIT_K,
  DEFAULT_SEGMENT_SLOT_CAP,
  resolveCacheConfig,
} from "../src/engine/validate";
import { ConfigError } from "../src/errors";
import type { CacheConfig } from "../src/types";

const minimal: CacheConfig = {
  id: "candles-1m",
  interval: 60_000,
  fields: { close: "f64" },
};

/** Bypass compile-time checks to exercise runtime validation. */
function invalid(overrides: Record<string, unknown>): CacheConfig {
  return { ...minimal, ...overrides } as CacheConfig;
}

describe("resolveCacheConfig — valid input", () => {
  it("applies documented defaults", () => {
    const r = resolveCacheConfig(minimal);
    expect(r).toMatchObject({
      id: "candles-1m",
      interval: 60_000,
      alignmentOffset: 0,
      gapSplitK: DEFAULT_GAP_SPLIT_K,
      segmentSlotCap: DEFAULT_SEGMENT_SLOT_CAP,
      warnOnOverlapDiff: false,
    });
    expect(DEFAULT_GAP_SPLIT_K).toBe(4);
    expect(DEFAULT_SEGMENT_SLOT_CAP).toBe(32_768);
  });

  it("preserves explicit values", () => {
    const r = resolveCacheConfig({
      ...minimal,
      alignmentOffset: 34_200_000, // 09:30 session open on a daily interval
      interval: 86_400_000,
      gapSplitK: 8,
      segmentSlotCap: 1_024,
      warnOnOverlapDiff: true,
      version: "2026-06-11",
      finalizedUntil: 1_750_000_000_000,
    });
    expect(r.alignmentOffset).toBe(34_200_000);
    expect(r.gapSplitK).toBe(8);
    expect(r.segmentSlotCap).toBe(1_024);
    expect(r.warnOnOverlapDiff).toBe(true);
    expect(r.version).toBe("2026-06-11");
    expect(r.finalizedUntil).toBe(1_750_000_000_000);
  });

  it.each([
    ["negative", -1_000, 59_000],
    ["equal to interval", 60_000, 0],
    ["above interval", 125_000, 5_000],
    ["below -interval", -125_000, 55_000],
  ])("normalizes a %s alignmentOffset to the same grid in [0, interval)", (_label, offset, normalized) => {
    const r = resolveCacheConfig({ ...minimal, alignmentOffset: offset });
    expect(r.alignmentOffset).toBe(normalized);
    // Same grid: a timestamp aligned under the raw offset stays aligned.
    const t = 1_700_000_000_000 - (1_700_000_000_000 % 60_000) + normalized;
    expect((t - offset) % 60_000).toBe(0);
    expect((t - r.alignmentOffset) % 60_000).toBe(0);
  });

  it("returns a frozen config with a defensive copy of fields", () => {
    const fields = { close: "f64" } as const;
    const r = resolveCacheConfig({ ...minimal, fields: { ...fields } });
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.fields)).toBe(true);
    const input: CacheConfig = { ...minimal, fields: { close: "f64" } };
    const resolved = resolveCacheConfig(input);
    (input.fields as Record<string, string>).volume = "u32";
    expect(resolved.fields).toEqual({ close: "f64" });
  });

  it("accepts every documented dtype", () => {
    const r = resolveCacheConfig({
      ...minimal,
      fields: {
        a: "f64",
        b: "f32",
        c: "i32",
        d: "u32",
        e: "i16",
        f: "u16",
        g: "i8",
        h: "u8",
      },
    });
    expect(Object.keys(r.fields)).toHaveLength(8);
  });
});

describe("resolveCacheConfig — rejections (ConfigError naming the offender)", () => {
  it.each([
    ["empty id", { id: "" }, /id/],
    ["non-string id", { id: 7 }, /id/],
    ["missing interval", { interval: undefined }, /interval/],
    ["zero interval", { interval: 0 }, /interval/],
    ["negative interval", { interval: -60_000 }, /interval/],
    ["fractional interval", { interval: 1.5 }, /interval/],
    ["NaN interval", { interval: Number.NaN }, /interval/],
    ["Infinity interval", { interval: Number.POSITIVE_INFINITY }, /interval/],
    ["unsafe-integer interval", { interval: 2 ** 53 + 2 }, /interval/],
    ["fractional alignmentOffset", { alignmentOffset: 0.5 }, /alignmentOffset/],
    ["NaN alignmentOffset", { alignmentOffset: Number.NaN }, /alignmentOffset/],
    [
      "Infinity alignmentOffset",
      { alignmentOffset: Number.POSITIVE_INFINITY },
      /alignmentOffset/,
    ],
    [
      "unsafe-integer alignmentOffset",
      { alignmentOffset: 2 ** 53 + 2 },
      /alignmentOffset/,
    ],
    ["missing fields", { fields: undefined }, /fields/],
    ["empty fields", { fields: {} }, /fields/],
    ["unknown dtype", { fields: { x: "f128" } }, /f128/],
    ["empty field name", { fields: { "": "f64" } }, /field/],
    ["zero gapSplitK", { gapSplitK: 0 }, /gapSplitK/],
    ["fractional gapSplitK", { gapSplitK: 1.5 }, /gapSplitK/],
    ["zero segmentSlotCap", { segmentSlotCap: 0 }, /segmentSlotCap/],
    ["fractional segmentSlotCap", { segmentSlotCap: 0.5 }, /segmentSlotCap/],
    ["empty version", { version: "" }, /version/],
    ["non-string version", { version: 3 }, /version/],
    ["NaN finalizedUntil", { finalizedUntil: Number.NaN }, /finalizedUntil/],
    [
      "non-boolean warnOnOverlapDiff",
      { warnOnOverlapDiff: 1 },
      /warnOnOverlapDiff/,
    ],
  ])("rejects %s", (_label, overrides, pattern) => {
    expect(() => resolveCacheConfig(invalid(overrides))).toThrowError(
      ConfigError,
    );
    expect(() => resolveCacheConfig(invalid(overrides))).toThrowError(pattern);
  });

  it("gapSplitK of 1 and segmentSlotCap of 1 are legal minima", () => {
    const r = resolveCacheConfig({
      ...minimal,
      gapSplitK: 1,
      segmentSlotCap: 1,
    });
    expect(r.gapSplitK).toBe(1);
    expect(r.segmentSlotCap).toBe(1);
  });
});
