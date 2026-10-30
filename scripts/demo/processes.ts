// Every subprocess the demo launcher starts, builds and app servers alike.
// Each runs in a process group of its own, so stopping it stops whatever it
// started in turn (`bun run` starts vite, vite starts its workers).
//
// A group is registered only while it has a member. A pid that names an
// existing process group is never handed to a new process, so a registered
// id still names our group; once the group is empty its id is free for reuse
// and is retired at once, never signalled again. The leader's exit is the one
// event we hear: the group is checked then, and if its leader left children
// behind, checked again every SWEEP_MS until they are gone. Stopping signals
// only registered groups that still have members: SIGTERM, then SIGKILL to
// what is left after GRACE_MS, retiring each group as soon as it is empty.

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

/** How long the groups get to exit after SIGTERM before SIGKILL. */
const GRACE_MS = 3000;
/** How long SIGKILL may take to clear the groups. */
const KILL_MS = 2000;
const POLL_MS = 50;
/** How often a group whose leader exited is checked for remaining members. */
const SWEEP_MS = 250;

export interface Started {
  /** The group's id: the leader's pid, or undefined if it never started. */
  group: number | undefined;
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

/** `process.kill`, replaceable so tests can see every signal sent. */
export type Kill = (pid: number, signal: NodeJS.Signals | 0) => void;

export class Processes {
  readonly #kill: Kill;
  /** Groups that have, or may have, members: each leader's pid. */
  readonly #groups = new Set<number>();
  /** The registered groups whose leader has exited. */
  readonly #orphans = new Set<number>();
  #sweeper: ReturnType<typeof setInterval> | undefined;
  #stopping: Promise<void> | undefined;

  constructor(kill: Kill = (pid, signal) => process.kill(pid, signal)) {
    this.#kill = kill;
  }

  /** True once `stop()` has been called. */
  get stopping(): boolean {
    return this.#stopping !== undefined;
  }

  /** The registered groups, for tests. */
  get groups(): ReadonlySet<number> {
    return this.#groups;
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
    const group = child.pid;
    if (group !== undefined) this.#groups.add(group);
    let output = "";
    const keep = (chunk: Buffer) => {
      output += String(chunk);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    const exited = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => {
        if (group !== undefined) this.#leaderExited(group);
        resolve(code);
      });
      child.once("error", (error) => {
        output += String(error);
        resolve(-1);
      });
    });
    return { group, exited, output: () => output };
  }

  /** Stops every group; the same promise for every caller. */
  stop(): Promise<void> {
    this.#stopping ??= this.#stopAll();
    return this.#stopping;
  }

  /**
   * Whether the registered group still has a member; retires it if not.
   * EPERM means the id now names a process of another user: not ours, so
   * it is retired too.
   */
  #live(group: number): boolean {
    if (!this.#groups.has(group)) return false;
    try {
      this.#kill(-group, 0);
      return true;
    } catch {
      this.#retire(group);
      return false;
    }
  }

  #retire(group: number): void {
    this.#groups.delete(group);
    this.#orphans.delete(group);
    if (this.#orphans.size === 0 && this.#sweeper !== undefined) {
      clearInterval(this.#sweeper);
      this.#sweeper = undefined;
    }
  }

  #leaderExited(group: number): void {
    if (!this.#live(group)) return;
    // Its children live on in the group: check it until they are gone.
    this.#orphans.add(group);
    this.#sweeper ??= setInterval(() => {
      for (const orphan of [...this.#orphans]) this.#live(orphan);
    }, SWEEP_MS);
    this.#sweeper.unref?.();
  }

  /** Sends `name` to every registered group that still has a member. */
  #signal(name: NodeJS.Signals): void {
    for (const group of [...this.#groups]) {
      if (!this.#live(group)) continue;
      try {
        this.#kill(-group, name);
      } catch {
        this.#retire(group);
      }
    }
  }

  /** Resolves true once every group is retired, or false after `ms`. */
  async #emptied(ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    for (;;) {
      for (const group of [...this.#groups]) this.#live(group);
      if (this.#groups.size === 0) return true;
      if (Date.now() >= deadline) return false;
      await sleep(POLL_MS);
    }
  }

  async #stopAll(): Promise<void> {
    this.#signal("SIGTERM");
    if (await this.#emptied(GRACE_MS)) return;
    this.#signal("SIGKILL");
    if (!(await this.#emptied(KILL_MS))) {
      console.error(
        `demo: processes still running in groups ${[...this.#groups]}`,
      );
    }
  }
}
