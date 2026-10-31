import { describe, expect, it } from "vitest";
import { check, retriesSet } from "./test-clocks";

const rules = (text: string) => check("t.test.ts", text).map((f) => f.rule);

describe("test-clocks", () => {
  it("finds wall-clock reads, self-timing and sleeps", () => {
    expect(rules("const t = Date.now();")).toEqual(["wall clock"]);
    expect(rules("const d = new Date();")).toEqual(["wall clock"]);
    expect(rules("const t0 = performance.now();")).toEqual(["timing"]);
    expect(rules("await new Promise((r) => setTimeout(r, 10));")).toEqual([
      "sleep",
    ]);
    expect(rules("await page.waitForTimeout(500);")).toEqual(["sleep"]);
  });

  it("leaves alone what reads no clock and waits for nothing", () => {
    expect(rules("test.setTimeout(60_000);")).toEqual([]);
    expect(rules("const d = new Date(now);")).toEqual([]);
    expect(rules("vi.setSystemTime(Date.UTC(2026, 0, 1));")).toEqual([]);
    expect(rules("// Date.now() would flake here")).toEqual([]);
    expect(rules(" * a sleep: setTimeout(r, 10)")).toEqual([]);
    expect(rules("expect(x).toBe(1); // not Date.now()")).toEqual([]);
    expect(rules('const url = "http://example.com"; Date.now();')).toEqual([
      "wall clock",
    ]);
  });

  it("accepts a clock-ok comment with a reason, on the line or the one above", () => {
    expect(rules("Date.now(); // clock-ok: bounds a count from above")).toEqual(
      [],
    );
    expect(
      rules("// clock-ok: an absence check\nawait page.waitForTimeout(500);"),
    ).toEqual([]);
    expect(rules("Date.now(); // clock-ok:")).toEqual(["wall clock"]);
    expect(
      rules("// clock-ok: one line only\nconst a = 1;\nDate.now();"),
    ).toEqual(["wall clock"]);
  });

  it("names the file and line", () => {
    expect(check("a.spec.ts", "const a = 1;\nconst t = Date.now();")).toEqual([
      {
        file: "a.spec.ts",
        line: 2,
        rule: "wall clock",
        why: expect.any(String),
        text: "const t = Date.now();",
      },
    ]);
  });

  it("keeps Playwright's retries at 0", () => {
    expect(retriesSet("export default defineConfig({ testDir: 'e2e' });")).toBe(
      false,
    );
    expect(retriesSet("export default defineConfig({ retries: 0 });")).toBe(
      false,
    );
    expect(retriesSet("export default defineConfig({ retries: 2 });")).toBe(
      true,
    );
    expect(retriesSet("{ retries: process.env.CI ? 2 : 0 }")).toBe(true);
  });
});
