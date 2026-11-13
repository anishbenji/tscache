import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { demoPorts } from "../../scripts/demo/catalog";
import { apps as APPS } from "../examples/apps";

// The launcher (scripts/demo.ts) on its own. Every way out stops every
// process it started, builds included, with what they started in turn, and
// frees every port (step 30 R1-1, R2-2). The demo recorder
// (scripts/demo/record.ts), which starts the launcher, does the same when
// it is interrupted. Each test takes free ports the system picks, one for
// the hub and one per app, and kills anything left over however it ends.

const root = fileURLToPath(new URL("../..", import.meta.url));
const launcherPath = fileURLToPath(
  new URL("../../scripts/demo.ts", import.meta.url),
);
const recorderPath = fileURLToPath(
  new URL("../../scripts/demo/record.ts", import.meta.url),
);
/** Every app the launcher builds and serves. */
const APP_COUNT = Object.keys(APPS).length;
/** The hub's port and the apps' after it. */
const PORTS = APP_COUNT + 1;

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
  /**
   * Resolves with the exit code (null after a signal). No deadline of its
   * own: a launcher that never exits ends at the test's timeout
   * (docs/testing.md).
   */
  exit(): Promise<number | null>;
  /** The exit code once it has exited (null after a signal), else undefined. */
  code(): number | null | undefined;
  stdout(): string;
  stderr(): string;
}

function launch(
  hub: number,
  args: string[],
  env = {},
  script = launcherPath,
): Launch {
  const child = spawn("bun", [script, ...args], {
    cwd: root,
    env: { ...process.env, ...env, DEMO_PORT: String(hub) },
    // A group of its own, so cleanup can kill it whatever it started.
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  let code: number | null | undefined;
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", (exit) => {
      code = exit;
      resolve(exit);
    }),
  );
  return {
    child,
    exit: () => exited,
    code: () => code,
    stdout: () => stdout,
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
    const code = await launched.exit();
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
    expect(await launched.exit()).toBe(143);
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
    expect(await launched.exit()).toBe(null);
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
  while (readdirSync(dir).filter((f) => f.endsWith(".pids")).length < ${APP_COUNT}) {
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
    const code = await launched.exit();
    for (const file of await readdir(dir)) {
      if (!file.endsWith(".pids")) continue;
      const text = await readFile(join(dir, file), "utf8");
      pids.push(...text.split(" ").map(Number));
    }
    expect(code).toBe(1);
    expect(launched.stderr()).toContain("solid-uplot: build failed");
    // A build per app, each with a child; none outlives the launcher.
    expect(pids).toHaveLength(2 * APP_COUNT);
    expect(pids.filter(running)).toEqual([]);
    expect(await allFree([hub, ...apps])).toBe(true);
  } finally {
    for (const pid of pids) kill(pid);
    cleanUp(launched, apps);
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * Stands in for every build while the recorder waits for the demo: the
 * package's passes; each app's records its pid and a child's and runs for a
 * minute.
 */
const SLOW_BUILD = `
const [dir, name] = [process.env.FAKE_BUILD_DIR, process.argv[2]];
if (name === "tscache") process.exit(0);
const child = Bun.spawn(["sleep", "60"]);
await Bun.write(\`\${dir}/\${name}.pids\`, \`\${process.pid} \${child.pid}\`);
await Bun.sleep(60_000);
`;

/** The pids each fake build recorded in `dir`. */
async function recordedPids(dir: string): Promise<number[]> {
  const pids: number[] = [];
  for (const file of await readdir(dir)) {
    if (!file.endsWith(".pids")) continue;
    const text = await readFile(join(dir, file), "utf8");
    pids.push(...text.split(" ").map(Number));
  }
  return pids;
}

/**
 * The recorder's directories for its raw videos under `temp`; the demo's
 * servers keep caches of their own there (node-compile-cache).
 */
async function rawVideoDirs(temp: string): Promise<string[]> {
  return (await readdir(temp)).filter((name) =>
    name.startsWith("tscache-record-"),
  );
}

/** The recorder's direct children: the launcher and, once up, Chromium. */
function childrenOf(pid: number): number[] {
  try {
    return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map(Number);
  } catch (error) {
    // pgrep exits 1 when nothing matches.
    if ((error as { status?: unknown }).status !== 1) throw error;
    return [];
  }
}

/**
 * Ctrl-C in a terminal: SIGINT to the recorder's process group. The
 * launcher and its servers run in groups of their own, so it does not reach
 * them; only the recorder can stop them.
 */
function interrupt(launched: Launch): void {
  const pid = launched.child.pid;
  if (pid === undefined) throw new Error("the recorder did not start");
  process.kill(-pid, "SIGINT");
}

test("an interrupted recorder stops the demo's builds while it waits for them", async () => {
  test.setTimeout(90_000);
  const hub = await freePorts();
  const apps = appPortsAfter(hub);
  const dir = await mkdtemp(join(tmpdir(), "tscache-record-build-"));
  const temp = await mkdtemp(join(tmpdir(), "tscache-record-tmp-"));
  const script = join(dir, "build.ts");
  await writeFile(script, SLOW_BUILD);
  let launched: Launch | undefined;
  let pids: number[] = [];
  try {
    launched = launch(
      hub,
      [],
      {
        DEMO_BUILD_SCRIPT: script,
        FAKE_BUILD_DIR: dir,
        RECORD_FFMPEG: "true",
        TMPDIR: temp,
      },
      recorderPath,
    );
    await expect
      .poll(async () => (await recordedPids(dir)).length, { timeout: 60_000 })
      .toBe(2 * APP_COUNT);
    pids = await recordedPids(dir);
    interrupt(launched);
    expect(await launched.exit()).toBe(130);
    expect(pids.filter(running)).toEqual([]);
    expect(await allFree([hub, ...apps])).toBe(true);
    // Its directory for the raw videos is gone too.
    expect(await rawVideoDirs(temp)).toEqual([]);
  } finally {
    for (const pid of pids) kill(pid);
    cleanUp(launched, apps);
    await rm(dir, { recursive: true, force: true });
    await rm(temp, { recursive: true, force: true });
  }
});

test("an interrupted recorder stops Chromium and the demo while it records", async () => {
  test.setTimeout(120_000);
  const hub = await freePorts();
  const apps = appPortsAfter(hub);
  const temp = await mkdtemp(join(tmpdir(), "tscache-record-tmp-"));
  let launched: Launch | undefined;
  let children: number[] = [];
  try {
    launched = launch(
      hub,
      ["--reuse-builds", "--only", CONVERSION.name],
      {
        ...CONVERSION.env,
        // The probe holds until the recorder is interrupted.
        RECORD_PROBE: "hold",
        RECORD_FFMPEG: "true",
        TMPDIR: temp,
      },
      recorderPath,
    );
    const recorder = launched;
    await expect
      .poll(() => recorder.stdout(), { timeout: 90_000 })
      .toContain("probe holding");
    children = childrenOf(recorder.child.pid ?? 0);
    // Every process the recorder starts: the launcher, Chromium, and
    // Playwright's video encoder, an ffmpeg of its own.
    const commands = children.map(commandOf);
    expect(commands.some((c) => c.includes("scripts/demo.ts"))).toBe(true);
    expect(commands.some((c) => /chrom/i.test(c))).toBe(true);
    expect(commands.some((c) => c.includes("ms-playwright/ffmpeg"))).toBe(true);
    interrupt(recorder);
    expect(await recorder.exit()).toBe(130);
    // Named, so a process left over says what it is.
    expect(children.filter(running).map(described)).toEqual([]);
    expect(await allFree([hub, ...apps])).toBe(true);
    expect(await rawVideoDirs(temp)).toEqual([]);
  } finally {
    for (const pid of children) kill(pid);
    cleanUp(launched, apps);
    await rm(temp, { recursive: true, force: true });
  }
});

/**
 * Stands in for ffmpeg: writes a partial file at its output path (the last
 * argument), records its pid, and runs for a minute, as a long conversion
 * does.
 */
const SLOW_FFMPEG = `#!/usr/bin/env bun
const output = process.argv[process.argv.length - 1];
await Bun.write(output, "partial");
await Bun.write(\`\${process.env.FAKE_FFMPEG_DIR}/ffmpeg.pid\`, String(process.pid));
await Bun.sleep(60_000);
`;

/**
 * Waits until the recorder is converting (`converting` resolves true), and
 * fails at once, with its output, if it exits before that: a scenario's own
 * checks can fail it.
 */
async function untilConverting(
  recorder: Launch,
  converting: () => Promise<boolean>,
): Promise<void> {
  await expect
    .poll(async () => (await converting()) || recorder.code() !== undefined, {
      timeout: 110_000,
    })
    .toBe(true);
  if (!(await converting())) {
    throw new Error(
      `the recorder exited with ${recorder.code()} before converting:\n${recorder.stderr()}`,
    );
  }
}

/**
 * The scenario the conversion tests record, and what selects it. They test
 * the recorder's cancellation, so they must reach the conversion whatever
 * the demo's data does (the last test below).
 */
const CONVERSION = {
  name: "probe",
  env: { RECORD_PROBE: "1" } as Record<string, string>,
};

/** What each scenario's three media files hold before the recorder runs. */
const PREVIOUS = "previous";

function mediaFiles(root: string, name: string): string[] {
  return [
    join(root, "docs/media", `${name}.gif`),
    join(root, "site/public/media", `${name}.mp4`),
    join(root, "site/public/media", `${name}.webm`),
  ];
}

test("a recorder stopped while it converts leaves the media as they were and stops ffmpeg", async () => {
  test.setTimeout(120_000);
  const hub = await freePorts();
  const apps = appPortsAfter(hub);
  const temp = await mkdtemp(join(tmpdir(), "tscache-record-tmp-"));
  const fake = await mkdtemp(join(tmpdir(), "tscache-record-ffmpeg-"));
  const media = await mkdtemp(join(tmpdir(), "tscache-record-media-"));
  const ffmpeg = join(fake, "ffmpeg");
  await writeFile(ffmpeg, SLOW_FFMPEG, { mode: 0o755 });
  const files = mediaFiles(media, CONVERSION.name);
  await mkdir(join(media, "docs/media"), { recursive: true });
  await mkdir(join(media, "site/public/media"), { recursive: true });
  for (const file of files) await writeFile(file, PREVIOUS);
  let launched: Launch | undefined;
  let converting: number | undefined;
  try {
    launched = launch(
      hub,
      ["--reuse-builds", "--only", CONVERSION.name],
      {
        ...CONVERSION.env,
        RECORD_FFMPEG: ffmpeg,
        RECORD_MEDIA_ROOT: media,
        FAKE_FFMPEG_DIR: fake,
        TMPDIR: temp,
      },
      recorderPath,
    );
    const pidFile = join(fake, "ffmpeg.pid");
    await untilConverting(launched, async () =>
      Boolean(await readFile(pidFile, "utf8").catch(() => "")),
    );
    converting = Number(await readFile(pidFile, "utf8"));
    // SIGTERM to the recorder alone: ffmpeg, in its group, hears nothing,
    // so only the recorder can stop it.
    launched.child.kill("SIGTERM");
    expect(await launched.exit()).toBe(143);
    expect(running(converting)).toBe(false);
    for (const file of files) {
      expect(await readFile(file, "utf8")).toBe(PREVIOUS);
    }
    // Nothing else was written beside them.
    expect(await readdir(join(media, "docs/media"))).toEqual([
      `${CONVERSION.name}.gif`,
    ]);
    expect((await readdir(join(media, "site/public/media"))).sort()).toEqual([
      `${CONVERSION.name}.mp4`,
      `${CONVERSION.name}.webm`,
    ]);
    expect(await allFree([hub, ...apps])).toBe(true);
    expect(await rawVideoDirs(temp)).toEqual([]);
  } finally {
    if (converting !== undefined) kill(converting);
    cleanUp(launched, apps);
    for (const dir of [temp, fake, media]) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

/**
 * Stands in for ffmpeg as a conversion that ends on its own while the
 * recorder cleans up: writes its output and appends its pid to `starts`.
 * An output that does not end in FAKE_FFMPEG_HOLD (every output when it is
 * empty) is done at once. The one it holds on exits 0 as soon as the
 * recorder's Chromium (whose pid the test writes to `chromium`) is gone, or
 * on SIGTERM, which it traps and answers with a clean exit, as an ffmpeg
 * that finished at that moment would.
 */
const FINISHING_FFMPEG = `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const dir = process.env.FAKE_FFMPEG_DIR;
const output = process.argv[process.argv.length - 1];
appendFileSync(\`\${dir}/starts\`, \`\${process.pid}\\n\`);
await Bun.write(output, "converted");
if (!output.endsWith(process.env.FAKE_FFMPEG_HOLD ?? "")) process.exit(0);
process.on("SIGTERM", () => process.exit(0));
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
for (;;) {
  const file = \`\${dir}/chromium\`;
  if (existsSync(file) && !alive(Number(readFileSync(file, "utf8")))) break;
  await Bun.sleep(5);
}
`;

/** `pid` with its state and command line, as `ps` shows them. */
function described(pid: number): string {
  try {
    const shown = execFileSync(
      "ps",
      ["-o", "stat=,command=", "-p", String(pid)],
      {
        encoding: "utf8",
      },
    );
    return `${pid} ${shown.trim()}`;
  } catch {
    return `${pid} (gone)`;
  }
}

/** The command line of `pid`, or "" once it has exited. */
function commandOf(pid: number): string {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();
  } catch (error) {
    // ps exits 1 when no such process exists.
    if ((error as { status?: unknown }).status !== 1) throw error;
    return "";
  }
}

/** The stand-in ffmpeg processes running now, by their script's path. */
function standIns(script: string): number[] {
  try {
    return execFileSync("pgrep", ["-f", "--", script], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map(Number);
  } catch (error) {
    // pgrep exits 1 when nothing matches.
    if ((error as { status?: unknown }).status !== 1) throw error;
    return [];
  }
}

async function starts(dir: string): Promise<number[]> {
  const text = await readFile(join(dir, "starts"), "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map(Number);
}

/**
 * The stop lands during the first of a scenario's three conversions (the
 * MP4), where the next one's start is what must not happen; or during the
 * last (the GIF), where only the checks after ffmpeg exits and before the
 * install stand between the signal and the committed media (Codex round 1).
 */
const STOPS = [
  {
    title:
      "once a recorder is stopped, no ffmpeg starts and no media file changes",
    hold: "",
    startsBefore: 1,
  },
  {
    title:
      "once a recorder is stopped during the last conversion, no media file changes",
    hold: ".gif",
    startsBefore: 3,
  },
] as const;

for (const { title, hold, startsBefore } of STOPS) {
  test(title, async () => {
    test.setTimeout(120_000);
    const hub = await freePorts();
    const apps = appPortsAfter(hub);
    const temp = await mkdtemp(join(tmpdir(), "tscache-record-tmp-"));
    const fake = await mkdtemp(join(tmpdir(), "tscache-record-ffmpeg-"));
    const media = await mkdtemp(join(tmpdir(), "tscache-record-media-"));
    const ffmpeg = join(fake, "ffmpeg");
    await writeFile(ffmpeg, FINISHING_FFMPEG, { mode: 0o755 });
    const files = mediaFiles(media, CONVERSION.name);
    await mkdir(join(media, "docs/media"), { recursive: true });
    await mkdir(join(media, "site/public/media"), { recursive: true });
    for (const file of files) await writeFile(file, PREVIOUS);
    let launched: Launch | undefined;
    let started: number[] = [];
    try {
      launched = launch(
        hub,
        ["--reuse-builds", "--only", CONVERSION.name],
        {
          ...CONVERSION.env,
          RECORD_FFMPEG: ffmpeg,
          RECORD_MEDIA_ROOT: media,
          FAKE_FFMPEG_DIR: fake,
          FAKE_FFMPEG_HOLD: hold,
          TMPDIR: temp,
        },
        recorderPath,
      );
      const recorder = launched;
      // The conversion the stop lands in has begun.
      await untilConverting(
        recorder,
        async () => (await starts(fake)).length === startsBefore,
      );
      started = await starts(fake);
      const chromium = childrenOf(recorder.child.pid ?? 0).find((pid) =>
        /chrom/i.test(commandOf(pid)),
      );
      if (chromium === undefined) throw new Error("no Chromium child");
      // The conversion ends on its own as soon as the recorder's cleanup is
      // under way (its Chromium gone). Then SIGTERM to the recorder alone.
      await writeFile(join(fake, "chromium"), String(chromium));
      recorder.child.kill("SIGTERM");
      expect(await recorder.exit()).toBe(143);
      expect(running(chromium)).toBe(false);
      // No ffmpeg outlives the recorder: none started after the signal.
      expect(standIns(ffmpeg)).toEqual([]);
      expect(await starts(fake)).toEqual(started);
      for (const file of files) {
        expect(await readFile(file, "utf8")).toBe(PREVIOUS);
      }
      expect(await rawVideoDirs(temp)).toEqual([]);
      expect(await allFree([hub, ...apps])).toBe(true);
    } finally {
      for (const pid of [...started, ...standIns(ffmpeg)]) kill(pid);
      cleanUp(launched, apps);
      for (const dir of [temp, fake, media]) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });
}

test("the conversion tests reach the conversion whatever the demo's data does", async () => {
  test.setTimeout(120_000);
  const hub = await freePorts();
  const apps = appPortsAfter(hub);
  const temp = await mkdtemp(join(tmpdir(), "tscache-record-tmp-"));
  const fake = await mkdtemp(join(tmpdir(), "tscache-record-ffmpeg-"));
  const media = await mkdtemp(join(tmpdir(), "tscache-record-media-"));
  const ffmpeg = join(fake, "ffmpeg");
  await writeFile(ffmpeg, SLOW_FFMPEG, { mode: 0o755 });
  let launched: Launch | undefined;
  let converting: number | undefined;
  try {
    launched = launch(
      hub,
      ["--reuse-builds", "--only", CONVERSION.name],
      {
        ...CONVERSION.env,
        RECORD_FFMPEG: ffmpeg,
        RECORD_MEDIA_ROOT: media,
        FAKE_FFMPEG_DIR: fake,
        TMPDIR: temp,
      },
      recorderPath,
    );
    // Every series request of the recorded app fails from the moment its
    // backend answers, so a scenario that waited for its data or checked a
    // count of it would fail on every run.
    const backend = `http://127.0.0.1:${demoPorts(hub)["reference-vanilla"]}/api/`;
    await expect
      .poll(
        async () =>
          (await fetch(`${backend}stats`).catch(() => undefined))?.ok ?? false,
        { timeout: 110_000, intervals: [20] },
      )
      .toBe(true);
    const failing = await fetch(`${backend}control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ failNext: 1_000_000 }),
    });
    expect(failing.ok).toBe(true);
    const pidFile = join(fake, "ffmpeg.pid");
    await untilConverting(launched, async () =>
      Boolean(await readFile(pidFile, "utf8").catch(() => "")),
    );
    converting = Number(await readFile(pidFile, "utf8"));
    launched.child.kill("SIGTERM");
    expect(await launched.exit()).toBe(143);
    expect(running(converting)).toBe(false);
    expect(await allFree([hub, ...apps])).toBe(true);
    expect(await rawVideoDirs(temp)).toEqual([]);
  } finally {
    if (converting !== undefined) kill(converting);
    cleanUp(launched, apps);
    for (const dir of [temp, fake, media]) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("a recorder whose hub port is taken stops at once and sends that port nothing", async () => {
  test.setTimeout(60_000);
  const hub = await freePorts();
  const apps = appPortsAfter(hub);
  const temp = await mkdtemp(join(tmpdir(), "tscache-record-tmp-"));
  // Another demo, or anything else, already on the hub's port.
  const taken = await listen(hub);
  let connections = 0;
  taken.server.on("connection", () => {
    connections += 1;
  });
  let launched: Launch | undefined;
  try {
    launched = launch(
      hub,
      ["--reuse-builds", "--only", CONVERSION.name],
      { ...CONVERSION.env, RECORD_FFMPEG: "true", TMPDIR: temp },
      recorderPath,
    );
    expect(await launched.exit()).toBe(1);
    expect(launched.stderr()).toContain(`port ${hub} is already in use`);
    // It checked the port without connecting, and started no demo.
    expect(connections).toBe(0);
    expect(await allFree(apps)).toBe(true);
    expect(await rawVideoDirs(temp)).toEqual([]);
  } finally {
    cleanUp(launched, apps);
    await taken.close();
    await rm(temp, { recursive: true, force: true });
  }
});

/** An HTTP server on `port` that answers every request and counts them. */
function countingServer(port: number): Promise<{
  requests(): string[];
  close(): Promise<void>;
}> {
  const seen: string[] = [];
  const server = createHttpServer((request, response) => {
    seen.push(`${request.method} ${request.url}`);
    response.end("ok");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () =>
      resolve({
        requests: () => seen,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      }),
    );
  });
}

/** The recorded app's port in a demo whose hub is on `hub`. */
function recordedAppPort(hub: number): number {
  return demoPorts(hub)["reference-vanilla"];
}

for (const { title, args, message } of [
  {
    title: "a recorder that refuses a taken app port sends that port nothing",
    args: ["--reuse-builds", "--only", CONVERSION.name],
    message: (hub: number) => `port ${recordedAppPort(hub)} is already in use`,
  },
  {
    title:
      "a recorder that stops on a bad option sends the demo's ports nothing",
    args: ["--reuse-builds", "--only", "no-such-scenario"],
    message: () => "--only names none of",
  },
]) {
  test(title, async () => {
    test.setTimeout(60_000);
    const hub = await freePorts();
    const apps = appPortsAfter(hub);
    const temp = await mkdtemp(join(tmpdir(), "tscache-record-tmp-"));
    // Something answering on the recorded app's port: another demo's
    // backend, as far as the recorder can tell.
    const backend = await countingServer(recordedAppPort(hub));
    let launched: Launch | undefined;
    try {
      launched = launch(
        hub,
        args,
        { ...CONVERSION.env, RECORD_FFMPEG: "true", TMPDIR: temp },
        recorderPath,
      );
      expect(await launched.exit()).toBe(1);
      expect(launched.stderr()).toContain(message(hub));
      // It undid nothing it had not done: no control, no read.
      expect(backend.requests()).toEqual([]);
      expect(await rawVideoDirs(temp)).toEqual([]);
    } finally {
      cleanUp(launched, apps);
      await backend.close();
      await rm(temp, { recursive: true, force: true });
    }
  });
}

test("a recorder that refuses a taken app port exits though that port never answers", async () => {
  test.setTimeout(30_000);
  const hub = await freePorts();
  const apps = appPortsAfter(hub);
  const temp = await mkdtemp(join(tmpdir(), "tscache-record-tmp-"));
  // Accepts connections and never answers on them.
  const silent = await listen(recordedAppPort(hub));
  let launched: Launch | undefined;
  try {
    launched = launch(
      hub,
      ["--reuse-builds", "--only", CONVERSION.name],
      { ...CONVERSION.env, RECORD_FFMPEG: "true", TMPDIR: temp },
      recorderPath,
    );
    // No deadline of its own: a recorder that hangs fails at the test's
    // timeout (docs/testing.md).
    expect(await launched.exit()).toBe(1);
    expect(launched.stderr()).toContain(
      `port ${recordedAppPort(hub)} is already in use`,
    );
  } finally {
    cleanUp(launched, apps);
    await silent.close();
    await rm(temp, { recursive: true, force: true });
  }
});

/**
 * Stands in for every build: each app's passes at once; the package's,
 * which runs first, marks that it runs and waits until the test has taken
 * the recorded app's port, so the port is taken after the recorder's port
 * check and before any app server starts.
 */
const PORT_TAKING_BUILD = `
import { existsSync } from "node:fs";
const [dir, name] = [process.env.FAKE_BUILD_DIR, process.argv[2]];
if (name !== "tscache") process.exit(0);
await Bun.write(\`\${dir}/building\`, "");
while (!existsSync(\`\${dir}/taken\`)) {
  // The test's cleanup removed the directory: it ended without taking the
  // port, so this build is not left running.
  if (!existsSync(dir)) process.exit(1);
  await Bun.sleep(20);
}
`;

test("a launcher whose app port is taken during the build refuses that app, and the recorder sends it nothing", async () => {
  test.setTimeout(90_000);
  const hub = await freePorts();
  const apps = appPortsAfter(hub);
  const dir = await mkdtemp(join(tmpdir(), "tscache-record-build-"));
  const temp = await mkdtemp(join(tmpdir(), "tscache-record-tmp-"));
  const script = join(dir, "build.ts");
  await writeFile(script, PORT_TAKING_BUILD);
  let launched: Launch | undefined;
  let backend: Awaited<ReturnType<typeof countingServer>> | undefined;
  try {
    launched = launch(
      hub,
      ["--only", CONVERSION.name],
      {
        ...CONVERSION.env,
        DEMO_BUILD_SCRIPT: script,
        FAKE_BUILD_DIR: dir,
        RECORD_FFMPEG: "true",
        TMPDIR: temp,
      },
      recorderPath,
    );
    const recorder = launched;
    // The recorder has checked its ports and its launcher is building.
    await expect
      .poll(
        async () =>
          (await readdir(dir)).includes("building") ||
          recorder.code() !== undefined,
        { timeout: 60_000 },
      )
      .toBe(true);
    expect(recorder.code(), recorder.stderr()).toBeUndefined();
    // Something else answers on the recorded app's port from now on.
    backend = await countingServer(recordedAppPort(hub));
    await writeFile(join(dir, "taken"), "");
    expect(await recorder.exit()).toBe(1);
    const output = `${recorder.stdout()}${recorder.stderr()}`;
    // The launcher refused the app whose own server could not listen, and
    // never printed its hub line.
    expect(output).toContain("reference-vanilla: vite preview exited");
    expect(output).not.toContain("tscache demo hub:");
    // Neither the launcher nor the recorder sent that port anything.
    expect(backend.requests()).toEqual([]);
    const recorded = recordedAppPort(hub);
    expect(await allFree([hub, ...apps.filter((p) => p !== recorded)])).toBe(
      true,
    );
    expect(await rawVideoDirs(temp)).toEqual([]);
  } finally {
    cleanUp(launched, apps);
    await backend?.close();
    await rm(dir, { recursive: true, force: true });
    await rm(temp, { recursive: true, force: true });
  }
});

/** The app server that holds its answer, and the one that fails. */
const HOLDING_APP = "solid-uplot";
const FAILING_APP = "vanilla-uplot";

/**
 * Stands in for every app's `vite preview` (DEMO_SERVE_SCRIPT), so the test
 * sets the order in which the launcher's checks meet a shutdown. Every app
 * listens, says so on vite's "Local:" line and answers. FAILING_APP exits 1
 * once it has answered and HOLDING_APP has been asked. HOLDING_APP says it
 * listens only once FAILING_APP has answered, and holds its first answer
 * until the launcher's shutdown signals it (SIGTERM): the launcher then reads
 * an "ok" while it is stopping.
 */
const ORDERED_SERVE = `
import { existsSync } from "node:fs";
const [app, port] = [process.argv[2], Number(process.argv[3])];
const dir = process.env.FAKE_SERVE_DIR;
// The test's cleanup removed the directory: nothing is left listening.
setInterval(() => existsSync(dir) || process.exit(1), 100);
let release = () => {};
const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch() {
    if (app === "${FAILING_APP}") Bun.write(\`\${dir}/answered\`, "");
    if (app !== "${HOLDING_APP}") return new Response("ok");
    Bun.write(\`\${dir}/asked\`, "");
    return new Promise((resolve) => {
      release = () => resolve(new Response("ok"));
    });
  },
});
const until = async (name) => {
  while (!existsSync(\`\${dir}/\${name}\`)) await Bun.sleep(10);
};
if (app === "${HOLDING_APP}") {
  process.on("SIGTERM", async () => {
    release();
    await server.stop();
    process.exit(0);
  });
  await until("answered");
}
console.log(\`  ➜  Local:   http://127.0.0.1:\${port}/\`);
if (app === "${FAILING_APP}") {
  await until("answered");
  await until("asked");
  process.exit(1);
}
`;

/** Stands in for every build: each passes at once. */
const PASSING_BUILD = "process.exit(0);\n";

test("a launcher whose app server fails while another answers prints no hub line", async () => {
  test.setTimeout(60_000);
  const hub = await freePorts();
  const apps = appPortsAfter(hub);
  const dir = await mkdtemp(join(tmpdir(), "tscache-demo-serve-"));
  const serve = join(dir, "serve.ts");
  const build = join(dir, "build.ts");
  await writeFile(serve, ORDERED_SERVE);
  await writeFile(build, PASSING_BUILD);
  let launched: Launch | undefined;
  try {
    launched = launch(hub, [], {
      DEMO_BUILD_SCRIPT: build,
      DEMO_SERVE_SCRIPT: serve,
      FAKE_SERVE_DIR: dir,
    });
    expect(await launched.exit()).toBe(1);
    expect(launched.stderr()).toContain(
      `${FAILING_APP}: vite preview exited with 1`,
    );
    // The order the test sets up happened: the holding app was asked, and
    // its answer came once the shutdown had begun.
    expect(await readdir(dir)).toEqual(
      expect.arrayContaining(["answered", "asked"]),
    );
    expect(launched.stdout()).not.toContain("tscache demo hub:");
    expect(await allFree([hub, ...apps])).toBe(true);
  } finally {
    cleanUp(launched, apps);
    await rm(dir, { recursive: true, force: true });
  }
});
