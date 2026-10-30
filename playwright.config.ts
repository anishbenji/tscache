import { defineConfig, devices } from "@playwright/test";
import {
  type App,
  appDir,
  appPort,
  apps,
  appUrl,
  offset,
  serverPort,
} from "./e2e/examples/apps";
import { hubPort } from "./scripts/demo/catalog";

// Multi-tab SharedWorker suites (step ⑫): one BrowserContext, multiple
// context.newPage() calls — pages share the SharedWorker; separate contexts
// isolate it. Vitest browser mode cannot model this (one page per file).
//
// The suite runs against the built package (bun run build first; CI does)
// served by scripts/e2e-server.ts, because workers need a same-origin URL.
//
// The examples project (step ⑬) builds each example app and serves it with
// `vite preview`, and so does the reference clients' spec (e2e/reference/).
// E2E_EXAMPLES=a,b limits which apps are started (empty: none), for running
// one app's spec while the others are being worked on.
//
// Every port carries a per-checkout offset (e2e/examples/apps.ts), so two
// checkouts can run the suite at once without sharing a server.
//
// The demo project (e2e/demo/) runs the demo hub, `bun run demo`, on ports
// of its own, offset like the others unless DEMO_PORT is set. Its server
// comes last: Playwright starts the servers in order, so the examples'
// servers have built every app it can reuse. It runs when E2E_EXAMPLES is
// unset or names `demo`.
const requested = process.env.E2E_EXAMPLES?.split(",");
const selected = (requested ?? Object.keys(apps)).filter((name): name is App =>
  Object.hasOwn(apps, name),
);
const demo = requested === undefined || requested.includes("demo");
const demoPort = hubPort(process.env) + (process.env.DEMO_PORT ? 0 : offset);
const hub = `http://127.0.0.1:${demoPort}/`;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: `http://127.0.0.1:${serverPort}/` },
  projects: [
    {
      name: "chromium",
      testIgnore: ["examples/**", "reference/**", "demo/**"],
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "examples",
      testMatch: ["examples/**/*.spec.ts", "reference/**/*.spec.ts"],
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "demo",
      testMatch: ["demo/**/*.spec.ts"],
      retries: 0,
      use: { ...devices["Desktop Chrome"], baseURL: hub },
    },
  ],
  webServer: [
    {
      command: "bun scripts/e2e-server.ts",
      env: { E2E_PORT: String(serverPort) },
      url: `http://127.0.0.1:${serverPort}/healthz`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    ...selected.map((app) => ({
      command: `bun run --cwd ${appDir(app)} build && bun run --cwd ${appDir(app)} preview --host 127.0.0.1 --port ${appPort(app)} --strictPort`,
      url: appUrl(app),
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    })),
    ...(demo
      ? [
          {
            command: "bun scripts/demo.ts --reuse-builds",
            env: { DEMO_PORT: String(demoPort) },
            url: `${hub}healthz`,
            reuseExistingServer: !process.env.CI,
            // Builds what the examples' servers did not, then starts nine.
            timeout: 300_000,
            // The launcher's servers run in process groups of their own,
            // which Playwright's default SIGKILL to the launcher's group
            // would miss; on SIGTERM the launcher stops them itself.
            gracefulShutdown: { signal: "SIGTERM" as const, timeout: 10_000 },
          },
        ]
      : []),
  ],
});
