import { mockBackend, ssrPage } from "@examples/mock-backend/vite";
import { fetcherUrl } from "tscache/vite";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [
    solid({ ssr: true }),
    mockBackend(),
    fetcherUrl(),
    ssrPage({ entry: "src/entry-server.tsx" }),
  ],
});
