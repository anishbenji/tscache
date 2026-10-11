import { fetcherUrl, mockBackend } from "@examples/mock-backend/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [mockBackend(), fetcherUrl()],
  build: {
    rolldownOptions: { input: ["index.html", "events.html"] },
  },
});
