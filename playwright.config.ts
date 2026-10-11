import { defineConfig, devices } from "@playwright/test";
import { type App, apps, appUrl } from "./e2e/examples/apps";

// Multi-tab SharedWorker suites (step ⑫): one BrowserContext, multiple
// context.newPage() calls — pages share the SharedWorker; separate contexts
// isolate it. Vitest browser mode cannot model this (one page per file).
//
// The suite runs against the built package (bun run build first; CI does)
// served by scripts/e2e-server.ts, because workers need a same-origin URL.
//
// The examples project (step ⑬) builds each example app and serves it with
// `vite preview`. E2E_EXAMPLES=a,b limits which apps are started (empty: none),
// for running one app's spec while the others are being worked on.
const selected = (
  process.env.E2E_EXAMPLES?.split(",") ?? Object.keys(apps)
).filter((name): name is App => Object.hasOwn(apps, name));

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: "http://127.0.0.1:4173/" },
  projects: [
    {
      name: "chromium",
      testIgnore: "examples/**",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "examples",
      testMatch: "examples/**/*.spec.ts",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: "bun scripts/e2e-server.ts",
      url: "http://127.0.0.1:4173/healthz",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    ...selected.map((app) => ({
      command: `bun run --cwd examples/${app} build && bun run --cwd examples/${app} preview --host 127.0.0.1 --port ${apps[app]} --strictPort`,
      url: appUrl(app),
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    })),
  ],
});
