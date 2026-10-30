import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

// The launcher (scripts/demo.ts) on its own. Every way out stops every
// process it started, builds included, with what they started in turn, and
// frees every port (step 30 R1-1, R2-2). Each test takes ten free ports
// the system picks, and kills anything left over however it ends.

const root = fileURLToPath(new URL("../..", import.meta.url));
const launcherPath = fileURLToPath(
  new URL("../../scripts/demo.ts", import.meta.url),
);
/** The hub's port and the nine apps' after it. */
const PORTS = 10;

/** A listener whose close() ends its connections instead of waiting. */
interface Held {
  server: Server;
  close(): Promise<void>;
}

function listen(port: number): Promise<Held> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    // Local tools open connections to new listeners and keep them (the T3
    // Code app does); server.close() alone would wait for them (R2-1).
    const sockets = new Set<Socket>();
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () =>
      resolve({
        server,
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      }),
    );
  });
}

/** Whether nothing listens on 127.0.0.1:`port`. */
async function free(port: number): Promise<boolean> {
  try {
    await (await listen(port)).close();
    return true;
  } catch {
    return false;
  }
}

/**
 * A run of PORTS free ports; returns the first. Taken above the suite's own
 * demo (whose port carries the checkout's offset), one block per worker,
 * and below the ephemeral range, where outgoing connections take their
 * local ports and a port found free can be taken a moment later.
 */
async function freePorts(): Promise<number> {
  const suite = Number(new URL(test.info().project.use.baseURL ?? "").port);
  const block = suite + 100 + test.info().parallelIndex * 100;
  for (let first = block; first < block + 100; first += PORTS) {
    const ports = Array.from({ length: PORTS }, (_, i) => first + i);
    if ((await Promise.all(ports.map(free))).every(Boolean)) return first;
  }
  throw new Error(`no ${PORTS} free ports in a row from ${block}`);
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function kill(pid: number, group = false): void {
  try {
    process.kill(group ? -pid : pid, "SIGKILL");
  } catch {
    // Gone already.
  }
}

interface Launch {
  child: ChildProcess;
  /** Resolves with the exit code, or "running" after `ms`. */
  exit(ms: number): Promise<number | null | "running">;
  stderr(): string;
}

function launch(hub: number, args: string[], env = {}): Launch {
  const child = spawn("bun", [launcherPath, ...args], {
    cwd: root,
    env: { ...process.env, ...env, DEMO_PORT: String(hub) },
    // A group of its own, so cleanup can kill it whatever it started.
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", resolve),
  );
  return {
    child,
    exit: (ms) =>
      Promise.race([
        exited,
        new Promise<"running">((resolve) =>
          setTimeout(() => resolve("running"), ms),
        ),
      ]),
    stderr: () => stderr,
  };
}

/** Kills whatever a test left: the launcher's group and any app server. */
function cleanUp(launched: Launch | undefined, appPorts: number[]): void {
  if (launched?.child.pid !== undefined) kill(launched.child.pid, true);
  for (const port of appPorts) {
    let found = "";
    try {
      // "--" ends pgrep's options: the pattern itself starts with "--".
      found = execFileSync(
        "pgrep",
        ["-f", "--", `--port ${port} --strictPort`],
        {
          encoding: "utf8",
        },
      );
    } catch (error) {
      // pgrep exits 1 when nothing matches; anything else is a failed lookup,
      // which would leave the servers running unseen.
      if ((error as { status?: unknown }).status !== 1) throw error;
    }
    for (const pid of found.split("\n").filter(Boolean)) kill(Number(pid));
  }
}

function appPortsAfter(hub: number): number[] {
  return Array.from({ length: PORTS - 1 }, (_, i) => hub + 1 + i);
}

async function allFree(ports: number[]): Promise<boolean> {
  return (await Promise.all(ports.map(free))).every(Boolean);
}

test("a hub port in use stops the launcher and every app server it started", async () => {
  test.setTimeout(90_000);
  const hub = await freePorts();
  const apps = appPortsAfter(hub);
  const taken = await listen(hub);
  let launched: Launch | undefined;
  try {
    launched = launch(hub, ["--reuse-builds"]);
    const code = await launched.exit(60_000);
    expect(code).toBe(1);
    expect(launched.stderr()).toContain("EADDRINUSE");
    // The launcher exits only once every server's group is gone.
    expect(await allFree(apps)).toBe(true);
  } finally {
    cleanUp(launched, apps);
    await taken.close();
  }
});

test("SIGTERM stops a running demo and every app server", async ({
  request,
}) => {
  test.setTimeout(90_000);
  const hub = await freePorts();
  const apps = appPortsAfter(hub);
  let launched: Launch | undefined;
  try {
    launched = launch(hub, ["--reuse-builds"]);
    await expect
      .poll(
        async () =>
          (
            await request
              .get(`http://127.0.0.1:${hub}/healthz`)
              .catch(() => null)
          )?.ok() ?? false,
        { timeout: 60_000 },
      )
      .toBe(true);
    launched.child.kill("SIGTERM");
    expect(await launched.exit(30_000)).toBe(143);
    expect(await allFree([hub, ...apps])).toBe(true);
  } finally {
    cleanUp(launched, apps);
  }
});

test("the tests' cleanup stops the app servers of a launcher killed outright", async ({
  request,
}) => {
  test.setTimeout(90_000);
  const hub = await freePorts();
  const apps = appPortsAfter(hub);
  let launched: Launch | undefined;
  try {
    launched = launch(hub, ["--reuse-builds"]);
    await expect
      .poll(
        async () =>
          (
            await request
              .get(`http://127.0.0.1:${hub}/healthz`)
              .catch(() => null)
          )?.ok() ?? false,
        { timeout: 60_000 },
      )
      .toBe(true);
    // SIGKILL to the launcher alone: its shutdown never runs, and the app
    // servers, each in a group of its own, outlive it.
    launched.child.kill("SIGKILL");
    expect(await launched.exit(10_000)).toBe(null);
    expect(await allFree(apps)).toBe(false);
    cleanUp(launched, apps);
    await expect.poll(() => allFree(apps), { timeout: 10_000 }).toBe(true);
  } finally {
    cleanUp(launched, apps);
  }
});

/**
 * Stands in for every build (DEMO_BUILD_SCRIPT). The package's passes; each
 * app's records its pid and a child's and runs for a minute; solid-uplot's
 * fails once every other app's build is running.
 */
const FAKE_BUILD = `
const [dir, name] = [process.env.FAKE_BUILD_DIR, process.argv[2]];
if (name === "tscache") process.exit(0);
const child = Bun.spawn(["sleep", "60"]);
await Bun.write(\`\${dir}/\${name}.pids\`, \`\${process.pid} \${child.pid}\`);
if (name === "solid-uplot") {
  const { readdirSync } = await import("node:fs");
  while (readdirSync(dir).filter((f) => f.endsWith(".pids")).length < 9) {
    await Bun.sleep(50);
  }
  console.error("solid-uplot: forced failure");
  process.exit(1);
}
await Bun.sleep(60_000);
`;

test("a failed build stops the other builds, with what they started", async () => {
  test.setTimeout(90_000);
  const hub = await freePorts();
  const apps = appPortsAfter(hub);
  const dir = await mkdtemp(join(tmpdir(), "tscache-demo-build-"));
  const script = join(dir, "build.ts");
  await writeFile(script, FAKE_BUILD);
  let launched: Launch | undefined;
  const pids: number[] = [];
  try {
    launched = launch(hub, [], {
      DEMO_BUILD_SCRIPT: script,
      FAKE_BUILD_DIR: dir,
    });
    const code = await launched.exit(60_000);
    for (const file of await readdir(dir)) {
      if (!file.endsWith(".pids")) continue;
      const text = await readFile(join(dir, file), "utf8");
      pids.push(...text.split(" ").map(Number));
    }
    expect(code).toBe(1);
    expect(launched.stderr()).toContain("solid-uplot: build failed");
    // Nine builds, each with a child; none outlives the launcher.
    expect(pids).toHaveLength(18);
    expect(pids.filter(running)).toEqual([]);
    expect(await allFree([hub, ...apps])).toBe(true);
  } finally {
    for (const pid of pids) kill(pid);
    cleanUp(launched, apps);
    await rm(dir, { recursive: true, force: true });
  }
});
