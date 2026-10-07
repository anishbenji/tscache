import { defineConfig, devices } from "@playwright/test";

// Multi-tab SharedWorker suites (step ⑫): one BrowserContext, multiple
// context.newPage() calls — pages share the SharedWorker; separate contexts
// isolate it. Vitest browser mode cannot model this (one page per file).
//
// The suite runs against the built package (bun run build first; CI does)
// served by scripts/e2e-server.ts, because workers need a same-origin URL.
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: "http://127.0.0.1:4173/" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "bun scripts/e2e-server.ts",
    url: "http://127.0.0.1:4173/",
    reuseExistingServer: !process.env.CI,
  },
});
