import { afterEach, describe, expect, it, vi } from "vitest";
import { onFeedStored } from "../src/feed";

describe("onFeedStored", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("adopts the choice stored now, not a delayed event's", () => {
    const stored = new Map<string, string>();
    const listeners: ((event: StorageEvent) => void)[] = [];
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
    });
    vi.stubGlobal("addEventListener", (_: string, listener: () => void) => {
      listeners.push(listener);
    });
    vi.stubGlobal("removeEventListener", () => {});
    const adopted: string[] = [];
    onFeedStored((kind) => adopted.push(kind));

    // Another tab chose ws, then this tab chose poll before ws's event came.
    stored.set("tscache-reference:feed", "poll");
    const late = { key: "tscache-reference:feed", newValue: "ws" };
    for (const listener of listeners) listener(late as StorageEvent);
    expect(adopted).toEqual(["poll"]);

    const other = { key: "tscache-reference:tokens", newValue: "{}" };
    for (const listener of listeners) listener(other as StorageEvent);
    expect(adopted).toEqual(["poll"]);
  });
});
