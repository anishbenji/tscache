// #region config
// vite.config.ts
import { fetcherUrl } from "tscache/vite";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [fetcherUrl()] });
// #endregion config
