// `bun run demo`: builds the package and every example app and reference
// client, serves each with `vite preview` (its mock backend included) on a
// port of its own, and serves the hub that links them all on DEMO_PORT
// (default 5400). Local addresses only. Ctrl-C stops everything.
//
// --reuse-builds builds only what has no dist/ yet. The Playwright suite
// starts the demo that way after the example specs' servers have built the
// apps, so it never rebuilds an app another server is serving.
//
// Every way out goes through shutdown(): a failed build or server, the hub's
// port in use, a signal. It stops every subprocess, builds included, with
// whatever they started (scripts/demo/processes.ts), then exits.

import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { type App, appDir, apps } from "../e2e/examples/apps";
import { demoPorts, hubPort } from "./demo/catalog";
import { hub } from "./demo/hub";
import { Processes } from "./demo/processes";

const root = new URL("..", import.meta.url);
/** The checkout as a path, decoded (a space stays a space), for subprocesses. */
const rootDir = fileURLToPath(root);
const reuseBuilds = process.argv.includes("--reuse-builds");
/**
 * For the launcher's tests only: `bun <script> <name>` runs in place of each
 * build, so a test can fail one without touching any dist/.
 */
const buildScript = process.env.DEMO_BUILD_SCRIPT;
const port = hubPort(process.env);
const ports = demoPorts(port);
const names = Object.keys(apps) as App[];
const origins = Object.fromEntries(
  names.map((app) => [app, `http://127.0.0.1:${ports[app]}/`]),
) as Record<App, string>;

const processes = new Processes();
let server: ReturnType<typeof Bun.serve> | undefined;
let exiting: Promise<never> | undefined;

/** The one way out: stops the hub and every subprocess, then exits. */
function shutdown(code: number, reason?: string): Promise<never> {
  exiting ??= (async () => {
    if (reason !== undefined) console.error(reason);
    void server?.stop(true);
    await processes.stop();
    process.exit(code);
  })();
  return exiting;
}

process.on("SIGINT", () => void shutdown(130));
process.on("SIGTERM", () => void shutdown(143));
process.on("SIGHUP", () => void shutdown(129));

/** Whether `dir` needs a build: always, or with --reuse-builds without a dist/. */
async function needsBuild(dir: string): Promise<boolean> {
  if (!reuseBuilds) return true;
  const dist = await stat(new URL(`${dir}/dist`, root)).catch(() => undefined);
  return dist?.isDirectory() !== true;
}

/** Runs a build; throws with its output if it fails. */
async function build(label: string, cmd: string[]): Promise<void> {
  const run = processes.start(
    buildScript === undefined ? cmd : ["bun", buildScript, label],
    { cwd: rootDir, capture: true },
  );
  const code = await run.exited;
  if (code !== 0) throw new Error(`${label}: build failed\n${run.output()}`);
  console.log(`built ${label}`);
}

function serve(app: App): void {
  const run = processes.start(
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
    { cwd: rootDir },
  );
  void run.exited.then((code) => {
    if (processes.stopping) return;
    void shutdown(1, `${app}: vite preview exited with ${code}`);
  });
}

/** Resolves once the app's server answers its page. */
async function ready(app: App): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !processes.stopping) {
    try {
      const response = await fetch(origins[app]);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(250);
  }
  throw new Error(`${app}: no answer on ${origins[app]}`);
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
  server = Bun.serve({ port, hostname: "127.0.0.1", fetch: hub(origins) });
}

/** The error and its code (EADDRINUSE for a port in use), on one line. */
function describe(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? `${error} (${code})` : String(error);
}

try {
  await start();
} catch (error) {
  await shutdown(
    1,
    `demo hub on port ${port} failed to start: ${describe(error)}`,
  );
}
console.log(`\ntscache demo hub: http://127.0.0.1:${port}/`);
for (const app of names) console.log(`  ${app.padEnd(18)} ${origins[app]}`);
