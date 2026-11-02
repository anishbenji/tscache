import { mockBackend } from "@examples/mock-backend/vite";
import react from "@vitejs/plugin-react";
import { fetcherUrl } from "tscache/vite";
import { defineConfig } from "vite";

export default defineConfig({
  // An ES worker can code-split: the persistence code the worker loads with
  // import() stays a chunk of its own instead of being inlined.
  worker: { format: "es" },
  plugins: [react(), mockBackend({ auth: true }), fetcherUrl()],
});
