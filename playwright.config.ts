import { defineConfig } from "@playwright/test";

// Multi-tab SharedWorker suites (step ⑫): one BrowserContext, multiple
// context.newPage() calls — pages share the SharedWorker; separate contexts
// isolate it. Vitest browser mode cannot model this (one page per file).
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
});
