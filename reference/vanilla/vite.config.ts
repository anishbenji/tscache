import { mockBackend, ssrPage } from "@examples/mock-backend/vite";
import { SERVICE_TOKEN } from "@reference/shared/server";
import { fetcherUrl } from "tscache/vite";
import { defineConfig } from "vite";

// Two pages: the client-only page at /, and the same page rendered on the
// server at /ssr. The mock backend requires a token, as a real one would.
export default defineConfig({
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
