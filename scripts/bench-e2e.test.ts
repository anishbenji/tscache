import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { persists, runEach } from "./bench-e2e";

describe("runEach", () => {
  it("runs every scenario after one fails, then rejects with every failure", async () => {
    const ran: string[] = [];
    const done: number[] = [];
    const failed: string[] = [];
    const run = async (name: string) => {
      ran.push(name);
      if (name === "b" || name === "d") throw new Error(`${name} broke`);
      return name.charCodeAt(0);
    };
    const outcome = runEach(["a", "b", "c", "d", "e"], run, {
      done: (result) => done.push(result),
      failed: (name) => failed.push(name),
    });
    const error = await outcome.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(ran).toEqual(["a", "b", "c", "d", "e"]);
    expect(done).toEqual([97, 99, 101]);
    expect(failed).toEqual(["b", "d"]);
    expect(error).toBeInstanceOf(AggregateError);
    const { errors, message } = error as AggregateError;
    expect(errors.map((e: Error) => e.message)).toEqual(["b broke", "d broke"]);
    expect(message).toBe("2 of 5 e2e scenarios failed: b: b broke; d: d broke");
  });

  it("resolves with every result, in order, when none fails", async () => {
    const results = await runEach(["a", "b"], async (name) => `${name}!`, {
      done: () => {},
      failed: () => {},
    });
    expect(results).toEqual(["a!", "b!"]);
  });

  it("keeps a thrown non-Error as the failure's message", async () => {
    const outcome = runEach(
      ["a"],
      async () => {
        throw "not an error";
      },
      { done: () => {}, failed: () => {} },
    );
    await expect(outcome).rejects.toThrow(
      "1 of 1 e2e scenarios failed: a: not an error",
    );
  });
});

describe("persists", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("is true only for a package src with a persist directory", () => {
    dir = mkdtempSync(join(tmpdir(), "tscache-persists-"));
    const src = join(dir, "src");
    mkdirSync(src);
    expect(persists(src)).toBe(false);
    mkdirSync(join(src, "persist"));
    expect(persists(src)).toBe(true);
  });
});
