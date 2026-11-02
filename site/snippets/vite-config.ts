// #region config
// vite.config.ts
import { fetcherUrl } from "tscache/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [fetcherUrl()],
  // An ES worker keeps the persistence code a chunk of its own, downloaded
  // only by a worker that persists (Vite's default 'iife' inlines it).
  worker: { format: "es" },
});

// #endregion config

// #region iife
// vite.config.ts of an app that keeps IIFE workers on purpose: the imports
// of the config above, these two, and this config as the default export
import { createLogger } from "vite";
import { withoutTscacheIifeWarning } from "./vite-logger";

export const iifeConfig = defineConfig({
  plugins: [fetcherUrl()],
  // Logs every message as Vite does, except tscache's IIFE warning.
  customLogger: withoutTscacheIifeWarning(createLogger()),
});
// #endregion iife
