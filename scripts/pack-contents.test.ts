import { describe, expect, it } from "vitest";
import { type Manifest, packProblems, parsePack } from "./pack-contents";

const manifest: Manifest = {
  exports: {
    ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
    "./worker": { types: "./dist/worker.d.ts", default: "./dist/worker.js" },
  },
  sideEffects: ["./dist/worker.js"],
};

const good = [
  "LICENSE",
  "README.md",
  "package.json",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/worker.js",
  "dist/worker.d.ts",
  "dist/engine-mNxnJYFt.js",
  "dist/types-BTmAMY9I.d.ts",
];

describe("packProblems", () => {
  it("accepts the manifest's files with built chunks", () => {
    expect(packProblems(good, manifest)).toEqual([]);
  });

  it("reports every required file the tarball lacks", () => {
    const files = good.filter(
      (file) => file !== "LICENSE" && file !== "dist/worker.d.ts",
    );
    expect(packProblems(files, manifest)).toEqual([
      "missing: LICENSE",
      "missing: dist/worker.d.ts",
    ]);
  });

  it("reports a source map, a test, a fixture and a source file", () => {
    const extra = [
      "dist/index.js.map",
      "dist/client.test.js",
      "dist/fixtures/a.js",
      "test/rpc.test.ts",
      "src/entries/index.ts",
      "dist/nested/chunk.js",
    ];
    expect(packProblems([...good, ...extra], manifest)).toEqual([
      "not allowed: dist/client.test.js",
      "not allowed: dist/fixtures/a.js",
      "not allowed: dist/index.js.map",
      "not allowed: dist/nested/chunk.js",
      "not allowed: src/entries/index.ts",
      "not allowed: test/rpc.test.ts",
    ]);
  });

  it("requires a file named in sideEffects", () => {
    const sideEffects = { ...manifest, sideEffects: ["./dist/setup.js"] };
    expect(packProblems(good, sideEffects)).toEqual(["missing: dist/setup.js"]);
  });
});

describe("parsePack", () => {
  const result = {
    filename: "anishbenji-tscache-0.1.0.tgz",
    size: 1,
    unpackedSize: 2,
    files: [{ path: "package.json", size: 3 }],
  };

  it("reads npm 11's array and npm 12's object keyed by name", () => {
    expect(parsePack(JSON.stringify([result]))).toEqual(result);
    expect(
      parsePack(JSON.stringify({ "@anishbenji/tscache": result })),
    ).toEqual(result);
  });

  it("refuses output that is not one package with a file list", () => {
    expect(() => parsePack("[]")).toThrow(/0 packages/);
    expect(() => parsePack(JSON.stringify([{ filename: "x" }]))).toThrow(
      /no file list/,
    );
  });
});
