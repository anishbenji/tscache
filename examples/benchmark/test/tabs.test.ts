import { describe, expect, it } from "vitest";
import type { TabMessage } from "../src/protocol";
import { Mailbox, openTogether } from "../src/tabs";

describe("Mailbox", () => {
  it("resolves a wait only with the message type it waits for", async () => {
    const box = new Mailbox();
    const disposed = box.next("a", "disposed");
    let settled = false;
    void disposed.then(() => {
      settled = true;
    });
    // A run's late answer is not the disposal.
    box.deliver({ type: "done", tab: "a", views: [] });
    await Promise.resolve();
    expect(settled).toBe(false);
    box.deliver({ type: "disposed", tab: "a" });
    await expect(disposed).resolves.toEqual({ type: "disposed", tab: "a" });
  });

  it("keeps each tab's waits apart", async () => {
    const box = new Mailbox();
    const a = box.next("a", "ready");
    const b = box.next("b", "ready");
    box.deliver({ type: "ready", tab: "b", setupMs: 2 });
    box.deliver({ type: "ready", tab: "a", setupMs: 1 });
    await expect(a).resolves.toMatchObject({ setupMs: 1 });
    await expect(b).resolves.toMatchObject({ setupMs: 2 });
  });

  it("rejects every wait of a tab that reports a failure", async () => {
    const box = new Mailbox();
    const done = box.next("a", "done");
    const disposed = box.next("a", "disposed");
    const failure: TabMessage = { type: "failed", tab: "a", error: "boom" };
    box.deliver(failure);
    await expect(done).rejects.toThrow("boom");
    await expect(disposed).rejects.toThrow("boom");
  });
});

describe("openTogether", () => {
  const tab = (log: string[], name: string) => ({
    name,
    close: async () => {
      log.push(`closed ${name}`);
    },
  });

  it("opens every tab", async () => {
    const log: string[] = [];
    const opened = await openTogether([
      async () => tab(log, "2"),
      async () => tab(log, "3"),
    ]);
    expect(opened.map((t) => t.name)).toEqual(["2", "3"]);
    expect(log).toEqual([]);
  });

  it("closes the tabs that opened when another fails, and rethrows", async () => {
    const log: string[] = [];
    await expect(
      openTogether([
        async () => tab(log, "2"),
        async () => {
          throw new Error("tab 3 failed");
        },
      ]),
    ).rejects.toThrow("tab 3 failed");
    expect(log).toEqual(["closed 2"]);
  });
});
