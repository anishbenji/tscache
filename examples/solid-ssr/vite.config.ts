import { fetcherUrl } from "@anishbenji/tscache/vite";
import { mockBackend, ssrPage } from "@examples/mock-backend/vite";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  // An ES worker can code-split: the persistence code the worker loads with
  // import() stays a chunk of its own instead of being inlined.
  worker: { format: "es" },
  plugins: [
    solid({ ssr: true }),
    mockBackend(),
    fetcherUrl(),
    ssrPage({ entry: "src/entry-server.tsx" }),
  ],
});
