import { spawn } from "node:child_process";
import { createServer, type Server } from "node:net";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

// The launcher (scripts/demo.ts) on its own: a start that fails leaves no
// server behind, so a second try can bind the same ports (step 30 R1-1).

const root = fileURLToPath(new URL("../..", import.meta.url));

function listen(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Whether nothing listens on 127.0.0.1:`port`. */
async function free(port: number): Promise<boolean> {
  try {
    await close(await listen(port));
    return true;
  } catch {
    return false;
  }
}

test("a hub port in use stops the launcher and every app server it started", async () => {
  test.setTimeout(120_000);
  // Away from the demo this suite runs, whose ports follow its hub's.
  const baseURL = test.info().project.use.baseURL ?? "";
  const hub = Number(new URL(baseURL).port) + 100;
  const apps = Array.from({ length: 9 }, (_, i) => hub + 1 + i);
  for (const port of apps) expect(await free(port)).toBe(true);
  const taken = await listen(hub);
  try {
    const launcher = spawn("bun", ["scripts/demo.ts", "--reuse-builds"], {
      cwd: root,
      env: { ...process.env, DEMO_PORT: String(hub) },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    launcher.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    // Before the fix the launcher never ended, holding its app servers.
    const code = await Promise.race([
      new Promise<number | null>((resolve) => launcher.once("exit", resolve)),
      new Promise<"running">((resolve) =>
        setTimeout(() => resolve("running"), 60_000),
      ),
    ]);
    if (code === "running") launcher.kill();
    expect(code).not.toBe("running");
    expect(code).not.toBe(0);
    expect(stderr).toContain("EADDRINUSE");
    // The app servers go with it, though they may take a moment to exit.
    await expect
      .poll(async () => (await Promise.all(apps.map(free))).every(Boolean), {
        timeout: 10_000,
      })
      .toBe(true);
  } finally {
    await close(taken);
  }
});
