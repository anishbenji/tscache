import { fetcherUrl } from "@anishbenji/tscache/vite";
import { mockBackend, ssrPage } from "@examples/mock-backend/vite";
import { SERVICE_TOKEN } from "@reference/shared/server";
import { defineConfig } from "vite";

// Two pages: the client-only page at /, and the same page rendered on the
// server at /ssr. The mock backend requires a token, as a real one would.
export default defineConfig({
  // An ES worker can code-split: the persistence code the worker loads with
  // import() stays a chunk of its own instead of being inlined.
  worker: { format: "es" },
  plugins: [
    mockBackend({ auth: true, serviceToken: SERVICE_TOKEN }),
    fetcherUrl(),
    ssrPage({
      entry: "src/entry-server.ts",
      path: "/ssr",
      template: "ssr.html",
    }),
  ],
  environments: {
    client: {
      build: { rolldownOptions: { input: ["index.html", "ssr.html"] } },
    },
  },
});
