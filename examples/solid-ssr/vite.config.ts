import { fetcherUrl, mockBackend, ssrPage } from "@examples/mock-backend/vite";
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
