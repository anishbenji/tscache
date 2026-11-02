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
