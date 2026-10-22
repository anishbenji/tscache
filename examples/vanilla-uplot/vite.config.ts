import { mockBackend } from "@examples/mock-backend/vite";
import { fetcherUrl } from "tscache/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [mockBackend(), fetcherUrl()],
  build: {
    rolldownOptions: { input: ["index.html", "events.html"] },
  },
});
