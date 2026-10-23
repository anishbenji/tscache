import { defineConfig } from "tsdown";

const shared = {
  format: "esm",
  dts: true,
  publint: true,
  attw: { profile: "esm-only" },
} as const;

export default defineConfig([
  {
    ...shared,
    entry: {
      index: "src/entries/index.ts",
      worker: "src/entries/worker.ts",
      engine: "src/entries/engine.ts",
      fetcher: "src/entries/fetcher.ts",
    },
    platform: "browser",
  },
  {
    // './vite' runs in Vite's Node process (N40): its own build, sharing no
    // chunk with the browser entries. tsdown cleans dist/ once for both
    // configs before either writes.
    ...shared,
    entry: { vite: "src/entries/vite.ts" },
    platform: "node",
    // .js and .d.ts like the other entries (the package is type: module).
    fixedExtension: false,
  },
]);
