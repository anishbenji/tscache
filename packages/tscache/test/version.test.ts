import { describe, expect, it } from "vitest";
import manifest from "../package.json" with { type: "json" };
import { LIB_VERSION } from "../src/rpc/protocol";

// Implementer test: the version every hosting reports in hello.lib is the
// version npm publishes, so a release that bumps package.json alone fails.
describe("LIB_VERSION", () => {
  it("equals the version in package.json", () => {
    expect(LIB_VERSION).toBe(manifest.version);
  });
});
