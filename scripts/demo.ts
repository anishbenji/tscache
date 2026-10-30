// `bun run demo`: builds the package and every example app and reference
// client, serves each with `vite preview` (its mock backend included) on a
// port of its own, and serves the hub that links them all on DEMO_PORT
// (default 5400). Local addresses only. Ctrl-C stops everything.
//
// --reuse-builds builds only what has no dist/ yet. The Playwright suite
// starts the demo that way after the example specs' servers have built the
// apps, so it never rebuilds an app another server is serving.

import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { type App, appDir, apps } from "../e2e/examples/apps";
import { demoPorts, hubPort } from "./demo/catalog";
import { hub } from "./demo/hub";

const root = new URL("..", import.meta.url);
/** The checkout as a path, decoded (a space stays a space), for subprocesses. */
const rootDir = fileURLToPath(root);
const reuseBuilds = process.argv.includes("--reuse-builds");
const port = hubPort(process.env);
const ports = demoPorts(port);
const names = Object.keys(apps) as App[];
const origins = Object.fromEntries(
  names.map((app) => [app, `http://127.0.0.1:${ports[app]}/`]),
) as Record<App, string>;

/** Servers started so far, stopped on exit. */
const children: Bun.Subprocess[] = [];
let stopping = false;

function stop(code: number): never {
  stopping = true;
  for (const child of children) child.kill();
  process.exit(code);
}

process.on("SIGINT", () => stop(130));
process.on("SIGTERM", () => stop(143));

/** Whether `dir` needs a build: always, or with --reuse-builds without a dist/. */
async function needsBuild(dir: string): Promise<boolean> {
  if (!reuseBuilds) return true;
  const dist = await stat(new URL(`${dir}/dist`, root)).catch(() => undefined);
  return dist?.isDirectory() !== true;
}

/** Runs a build, printing its output only if it fails. */
async function build(label: string, cmd: string[]): Promise<void> {
  const child = Bun.spawn(cmd, {
    cwd: rootDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    console.error(`${label}: build failed\n${out}${err}`);
    stop(1);
  }
  console.log(`built ${label}`);
}

function serve(app: App): void {
  const child = Bun.spawn(
    [
      "bun",
      "run",
      "--cwd",
      appDir(app),
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      String(ports[app]),
      "--strictPort",
    ],
    { cwd: rootDir, stdout: "ignore", stderr: "inherit" },
  );
  children.push(child);
  void child.exited.then((code) => {
    if (stopping) return;
    console.error(`${app}: vite preview exited with ${code}`);
    stop(1);
  });
}

/** Resolves once the app's server answers its page. */
async function ready(app: App): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(origins[app]);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(250);
  }
  console.error(`${app}: no answer on ${origins[app]}`);
  stop(1);
}

async function start(): Promise<void> {
  if (await needsBuild("packages/tscache")) {
    await build("tscache", ["bun", "run", "build"]);
  }
  await Promise.all(
    names.map(async (app) => {
      if (await needsBuild(appDir(app))) {
        await build(app, ["bun", "run", "--cwd", appDir(app), "build"]);
      }
    }),
  );
  for (const app of names) serve(app);
  await Promise.all(names.map(ready));
  Bun.serve({ port, hostname: "127.0.0.1", fetch: hub(origins) });
}

// Any failure to start, the hub's port in use included, stops the app
// servers started so far; left running, they would hold their ports.
await start().catch((error: unknown) => {
  console.error(`demo hub on port ${port} failed to start:`, error);
  stop(1);
});
console.log(`\ntscache demo hub: http://127.0.0.1:${port}/`);
for (const app of names) console.log(`  ${app.padEnd(18)} ${origins[app]}`);
