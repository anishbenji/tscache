import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/entries/index.ts",
    worker: "src/entries/worker.ts",
    engine: "src/entries/engine.ts",
    fetcher: "src/entries/fetcher.ts",
  },
  format: "esm",
  platform: "browser",
  dts: true,
  publint: true,
  attw: { profile: "esm-only" },
});
