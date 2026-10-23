import { mockBackend, ssrPage } from "@examples/mock-backend/vite";
import react from "@vitejs/plugin-react";
import { fetcherUrl } from "tscache/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    react(),
    mockBackend(),
    fetcherUrl(),
    ssrPage({ entry: "src/entry-server.tsx" }),
  ],
});
