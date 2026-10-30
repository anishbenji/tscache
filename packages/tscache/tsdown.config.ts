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
    // Rolldown replaces process.env.NODE_ENV on the browser platform; the
    // identity keeps it for the application's bundler to decide, so the
    // development-only merge warning (client/dev.ts) is dropped from
    // production builds instead of being fixed here.
    define: { "process.env.NODE_ENV": "process.env.NODE_ENV" },
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
