// Every subprocess the demo launcher starts, builds and app servers alike.
// Each runs in a process group of its own, so stopping it stops whatever it
// started in turn (`bun run` starts vite, vite starts its workers). Stopping
// sends SIGTERM to every group, waits a grace period, sends SIGKILL to what
// is left, and resolves once every group is gone.

import { spawn } from "node:child_process";

/** How long the groups get to exit after SIGTERM before SIGKILL. */
const GRACE_MS = 3000;
/** How long SIGKILL may take to clear the groups. */
const KILL_MS = 2000;
const POLL_MS = 50;

export interface Started {
  /** Resolves with the leader's exit code, or null when a signal ended it. */
  exited: Promise<number | null>;
  /** stdout and stderr so far, when started with `capture`. */
  output(): string;
}

export interface StartOptions {
  cwd: string;
  /** Keep the output for `output()`; otherwise stderr goes to ours. */
  capture?: boolean;
  env?: Record<string, string | undefined>;
}

/** Whether any process of the group is alive. */
function alive(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signal(group: number, name: NodeJS.Signals): void {
  try {
    process.kill(-group, name);
  } catch {
    // Gone already.
  }
}

/** Resolves once no group is alive, or after `ms`; true if all are gone. */
async function gone(groups: number[], ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (groups.some(alive)) {
    if (Date.now() >= deadline) return false;
    await Bun.sleep(POLL_MS);
  }
  return true;
}

export class Processes {
  /** Each started process's group id: its leader's pid. */
  readonly #groups = new Set<number>();
  #stopping: Promise<void> | undefined;

  /** True once `stop()` has been called. */
  get stopping(): boolean {
    return this.#stopping !== undefined;
  }

  /** Starts `cmd` in a group of its own; throws once stopping has begun. */
  start(cmd: readonly string[], options: StartOptions): Started {
    if (this.#stopping !== undefined) throw new Error("the demo is stopping");
    const [file = "", ...args] = cmd;
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      detached: true,
      stdio: options.capture
        ? ["ignore", "pipe", "pipe"]
        : ["ignore", "ignore", "inherit"],
    });
    if (child.pid !== undefined) this.#groups.add(child.pid);
    let output = "";
    const keep = (chunk: Buffer) => {
      output += String(chunk);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    const exited = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
      child.once("error", (error) => {
        output += String(error);
        resolve(-1);
      });
    });
    return { exited, output: () => output };
  }

  /** Stops every group; the same promise for every caller. */
  stop(): Promise<void> {
    this.#stopping ??= this.#stopAll();
    return this.#stopping;
  }

  async #stopAll(): Promise<void> {
    const groups = [...this.#groups];
    for (const group of groups) signal(group, "SIGTERM");
    if (await gone(groups, GRACE_MS)) return;
    for (const group of groups) signal(group, "SIGKILL");
    if (!(await gone(groups, KILL_MS))) {
      console.error(`demo: processes still running in groups ${groups}`);
    }
  }
}
