import { mockBackend } from "@examples/mock-backend/vite";
import { fetcherUrl } from "tscache/vite";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid(), mockBackend(), fetcherUrl()],
});
