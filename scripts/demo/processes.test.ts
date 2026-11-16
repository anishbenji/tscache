import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Kill, LAUNCHER_GRACE_MS, Processes, STOP_MS } from "./processes";

// The demo launcher's process registry (step 30 R4-1): a group is signalled
// only while it is registered and has members, and is retired, never to be
// signalled again, as soon as it is empty.

interface Call {
  pid: number;
  signal: NodeJS.Signals | 0;
}

/** process.kill, recording every call. */
function recording(): { kill: Kill; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    kill: (pid, signal) => {
      calls.push({ pid, signal });
      process.kill(pid, signal);
    },
  };
}

/** The signals other than the 0 probe sent to `group`. */
function signalsTo(calls: Call[], group: number): (NodeJS.Signals | 0)[] {
  return calls
    .filter((call) => call.pid === -group && call.signal !== 0)
    .map((call) => call.signal);
}

/** How many times `group` was probed for members (the 0 signal). */
function probesOf(calls: Call[], group: number): number {
  return calls.filter((call) => call.pid === -group && call.signal === 0)
    .length;
}

/** Whether process group `group` still has a member. */
function groupAlive(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch {
    return false;
  }
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const cwd = process.cwd();
/** Groups and pids a test started, killed after it however it ends. */
const leftovers: number[] = [];

afterEach(() => {
  for (const pid of leftovers.splice(0)) {
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, "SIGKILL");
      } catch {
        // Gone already.
      }
    }
  }
});

/** Starts `script` under sh and returns its group and its output's pid. */
async function startShell(processes: Processes, script: string) {
  const started = processes.start(["sh", "-c", script], {
    cwd,
    capture: true,
  });
  const group = started.group;
  if (group === undefined) throw new Error("sh did not start");
  leftovers.push(group);
  expect(await started.exited).toBe(0);
  return { group, started };
}

/** The pid the script echoed, once its output has arrived. */
async function echoedPid(output: () => string): Promise<number> {
  await expect.poll(() => output().trim()).toMatch(/^\d+$/);
  const pid = Number(output().trim());
  leftovers.push(pid);
  return pid;
}

describe("Processes", () => {
  it("retires a build that exits, and shutdown never signals its id", async () => {
    const { kill, calls } = recording();
    const processes = new Processes(kill);
    const { group } = await startShell(processes, "exit 0");
    expect(processes.groups.has(group)).toBe(false);
    await processes.stop();
    expect(signalsTo(calls, group)).toEqual([]);
  });

  it("retires a build whose child outlives it only once the child exits", async () => {
    const { kill, calls } = recording();
    const processes = new Processes(kill);
    // The child lives until the test ends it: a child that ended on its own
    // after a while could end before the checks below on a loaded machine.
    const { group, started } = await startShell(
      processes,
      "sleep 30 & echo $!",
    );
    const child = await echoedPid(started.output);
    // The leader is gone; its child keeps the group, so it stays registered,
    // through the check at the leader's exit and a sweep after it.
    await expect
      .poll(() => probesOf(calls, group), { timeout: 5000 })
      .toBeGreaterThanOrEqual(2);
    expect(running(child)).toBe(true);
    expect(processes.groups.has(group)).toBe(true);
    process.kill(child, "SIGTERM");
    await expect
      .poll(() => processes.groups.has(group), { timeout: 5000 })
      .toBe(false);
    // The group probe fails once the child has exited, but its pid answers
    // until launchd reaps the zombie: wait for that, as for any effect.
    await expect.poll(() => running(child), { timeout: 5000 }).toBe(false);
    await processes.stop();
    expect(signalsTo(calls, group)).toEqual([]);
  });

  it("stops a build's surviving child when shutdown comes first", async () => {
    const { kill, calls } = recording();
    const processes = new Processes(kill);
    const { group, started } = await startShell(
      processes,
      "sleep 30 & echo $!",
    );
    const child = await echoedPid(started.output);
    expect(processes.groups.has(group)).toBe(true);
    await processes.stop();
    expect(signalsTo(calls, group)).toEqual(["SIGTERM"]);
    // Stopped, but its pid answers until launchd reaps the zombie.
    await expect.poll(() => running(child), { timeout: 5000 }).toBe(false);
    expect(processes.groups.size).toBe(0);
  });

  it("stops a running server's group, and only once it is empty retires it", async () => {
    const { kill, calls } = recording();
    const processes = new Processes(kill);
    const started = processes.start(["sleep", "30"], { cwd });
    const group = started.group;
    if (group === undefined) throw new Error("sleep did not start");
    leftovers.push(group);
    expect(processes.groups.has(group)).toBe(true);
    await processes.stop();
    expect(signalsTo(calls, group)).toEqual(["SIGTERM"]);
    expect(await started.exited).toBe(null);
    expect(processes.groups.size).toBe(0);
  });

  it("retires a group whose id another user's process holds, without signalling it", async () => {
    // A probe answering EPERM: the id names a process that is not ours.
    const calls: Call[] = [];
    const processes = new Processes((pid, signal) => {
      calls.push({ pid, signal });
      if (signal === 0 && pid < 0) {
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      }
      process.kill(pid, signal);
    });
    const started = processes.start(["sleep", "30"], { cwd });
    const group = started.group;
    if (group === undefined) throw new Error("sleep did not start");
    leftovers.push(group);
    await processes.stop();
    expect(signalsTo(calls, group)).toEqual([]);
    expect(processes.groups.size).toBe(0);
  });

  it("copies a captured process's stderr to its sink as it arrives, and keeps it", async () => {
    const processes = new Processes();
    let copied = "";
    const started = processes.start(
      ["sh", "-c", "echo out; echo warn >&2; exec sleep 60"],
      {
        cwd,
        capture: true,
        stderr: {
          write: (chunk) => {
            copied += String(chunk);
          },
        },
      },
    );
    if (started.group !== undefined) leftovers.push(started.group);
    // While it still runs: copied as it arrives, not when it exits.
    await expect.poll(() => copied).toBe("warn\n");
    // stdout is its own pipe: wait for it too rather than rely on its order.
    await expect.poll(() => started.output()).toContain("out\n");
    expect(started.output()).toContain("warn\n");
    await processes.stop();
  });

  it("never sends SIGKILL to a launcher still within its own stop, and resolves once it and its groups are gone (step 110)", async () => {
    // A launcher as scripts/demo.ts is one: on SIGTERM it stops its own
    // groups and then exits. This one begins that stop only when the test
    // sends SIGUSR2, so it stands in for a launcher whose stop takes as
    // long as the test likes; the test lets STOP_MS pass, the longest a
    // launcher's own stop takes. A SIGKILL to the launcher before then would
    // leave its server running in a group the SIGKILL does not reach.
    const dir = await mkdtemp(join(tmpdir(), "tscache-processes-"));
    const script = join(dir, "launcher.ts");
    const module = fileURLToPath(new URL("./processes.ts", import.meta.url));
    await writeFile(
      script,
      `import { Processes } from ${JSON.stringify(module)};
const processes = new Processes();
process.on("SIGTERM", () => {});
process.on("SIGUSR2", async () => {
  await processes.stop();
  process.exit(143);
});
const server = processes.start(["sleep", "60"], { cwd: process.cwd() });
console.log(server.group);
`,
    );
    try {
      const { kill, calls } = recording();
      const processes = new Processes(kill, { graceMs: LAUNCHER_GRACE_MS });
      const launcher = processes.start(["bun", script], { cwd, capture: true });
      const group = launcher.group;
      if (group === undefined) throw new Error("the launcher did not start");
      leftovers.push(group);
      // Printed once its handlers are installed; echoedPid registers the
      // server, which leads its own group, for afterEach to kill.
      const server = await echoedPid(launcher.output);
      vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] });
      const stopped = processes.stop();
      await vi.advanceTimersByTimeAsync(STOP_MS);
      expect(signalsTo(calls, group)).toEqual(["SIGTERM"]);
      expect(groupAlive(group)).toBe(true);
      process.kill(group, "SIGUSR2");
      expect(await launcher.exited).toBe(143);
      // A probe within the grace left finds the launcher's group empty.
      await vi.advanceTimersByTimeAsync(LAUNCHER_GRACE_MS - STOP_MS - 1);
      await stopped;
      expect(signalsTo(calls, group)).toEqual(["SIGTERM"]);
      expect(groupAlive(server)).toBe(false);
    } finally {
      vi.useRealTimers();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("sends SIGKILL once a custom grace has passed, says so, and resolves with every group retired (step 110)", async () => {
    // Ignores SIGTERM, as a launcher stalled past its grace does; says
    // "ready" once it does, so the SIGTERM below cannot come first.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { kill, calls } = recording();
    const processes = new Processes(kill, { graceMs: LAUNCHER_GRACE_MS });
    const started = processes.start(
      ["sh", "-c", 'trap "" TERM; echo ready; exec sleep 60'],
      { cwd, capture: true },
    );
    const group = started.group;
    if (group === undefined) throw new Error("sh did not start");
    leftovers.push(group);
    try {
      await expect.poll(() => started.output()).toBe("ready\n");
      vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] });
      const stopped = processes.stop();
      await vi.advanceTimersByTimeAsync(LAUNCHER_GRACE_MS - 1);
      expect(signalsTo(calls, group)).toEqual(["SIGTERM"]);
      expect(errors).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(signalsTo(calls, group)).toEqual(["SIGTERM", "SIGKILL"]);
      expect(errors).toHaveBeenCalledTimes(1);
      expect(String(errors.mock.calls[0]?.[0])).toContain(String(group));
      expect(await started.exited).toBe(null);
      // The next probe finds the group empty.
      await vi.runOnlyPendingTimersAsync();
      await stopped;
      expect(processes.groups.size).toBe(0);
      expect(errors).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      errors.mockRestore();
    }
  });

  it("refuses to start once stopping", async () => {
    const processes = new Processes();
    await processes.stop();
    expect(() => processes.start(["true"], { cwd })).toThrow(/stopping/);
  });
});
