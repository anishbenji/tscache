import { afterEach, describe, expect, it } from "vitest";
import { type Kill, Processes } from "./processes";

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
    const { group, started } = await startShell(processes, "sleep 1 & echo $!");
    const child = await echoedPid(started.output);
    // The leader is gone; its child keeps the group, so it stays registered.
    expect(running(child)).toBe(true);
    expect(processes.groups.has(group)).toBe(true);
    await expect
      .poll(() => processes.groups.has(group), { timeout: 5000 })
      .toBe(false);
    expect(running(child)).toBe(false);
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
    expect(running(child)).toBe(false);
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

  it("refuses to start once stopping", async () => {
    const processes = new Processes();
    await processes.stop();
    expect(() => processes.start(["true"], { cwd })).toThrow(/stopping/);
  });
});
