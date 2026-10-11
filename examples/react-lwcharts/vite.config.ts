import { fetcherUrl, mockBackend } from "@examples/mock-backend/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), mockBackend({ auth: true }), fetcherUrl()],
});
