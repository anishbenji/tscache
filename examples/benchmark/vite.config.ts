import { fetcherUrl } from "@anishbenji/tscache/vite";
import { mockBackend } from "@examples/mock-backend/vite";
import { defineConfig } from "vite";

// Two pages: the benchmark at /, and the tab each of its iframes loads.
export default defineConfig({
  // An ES worker can code-split: the persistence code the worker loads with
  // import() stays a chunk of its own instead of being inlined.
  worker: { format: "es" },
  plugins: [mockBackend(), fetcherUrl()],
  build: {
    rolldownOptions: { input: ["index.html", "tab.html"] },
  },
});
