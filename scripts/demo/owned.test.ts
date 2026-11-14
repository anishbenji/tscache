import { describe, expect, it } from "vitest";
import { Owner } from "./owned";

// The demo recorder's ownership stack (scripts/demo/record.ts, shutdown):
// it releases what was acquired, newest first, and a resource acquired
// while it releases (an await that finished after shutdown began) is
// stopped at once and released too, never left behind.

/** A promise the test settles when it chooses. */
function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Owner", () => {
  it("releases what it owns newest first, each once", async () => {
    const owner = new Owner();
    const log: string[] = [];
    owner.own(() => log.push("raw"));
    owner.own(() => log.push("demo"));
    owner.own(() => log.push("browser"));
    await owner.releaseAll();
    expect(log).toEqual(["browser", "demo", "raw"]);
    await owner.releaseAll();
    expect(log).toEqual(["browser", "demo", "raw"]);
  });

  it("releases nothing that was disowned, and nothing never owned", async () => {
    const owner = new Owner();
    const log: string[] = [];
    owner.own(() => log.push("raw"));
    const disown = owner.own(() => log.push("context"));
    disown();
    await owner.releaseAll();
    expect(log).toEqual(["raw"]);
  });

  it("runs every stop before it awaits any release", async () => {
    const owner = new Owner();
    const log: string[] = [];
    owner.own(
      () => log.push("release raw"),
      () => log.push("stop raw"),
    );
    owner.own(
      () => log.push("release ffmpeg"),
      () => log.push("stop ffmpeg"),
    );
    const releasing = owner.releaseAll();
    // Synchronously, and before any release.
    expect(log.slice(0, 2)).toEqual(["stop ffmpeg", "stop raw"]);
    await releasing;
    expect(log).toEqual([
      "stop ffmpeg",
      "stop raw",
      "release ffmpeg",
      "release raw",
    ]);
  });

  it("keeps releasing after a release that fails", async () => {
    const owner = new Owner();
    const log: string[] = [];
    owner.own(() => log.push("raw"));
    owner.own(() => {
      throw new Error("already gone");
    });
    owner.own(() => Promise.reject(new Error("already gone")));
    await owner.releaseAll();
    expect(log).toEqual(["raw"]);
  });

  it("stops and releases a resource owned while it releases, before what was owned earlier", async () => {
    const owner = new Owner();
    const log: string[] = [];
    owner.own(() => log.push("release browser"));
    const clock = deferred();
    owner.own(async () => {
      log.push("release clock");
      await clock.promise;
    });
    const releasing = owner.releaseAll();
    expect(owner.releasing).toBe(true);
    // A context whose creation resolves while the clock's release is
    // pending: owned after release began.
    owner.own(
      () => log.push("release context"),
      () => log.push("stop context"),
    );
    expect(log).toEqual(["release clock", "stop context"]);
    clock.resolve();
    await releasing;
    expect(log).toEqual([
      "release clock",
      "stop context",
      "release context",
      "release browser",
    ]);
  });
});
