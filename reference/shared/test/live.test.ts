import type { Connection } from "@tscache/integrations/shared/connection";
import type { GetResult, Range, TscacheClient } from "tscache";
import { afterEach, describe, expect, it, vi } from "vitest";
import { liveFeed, socketAddress } from "../src/live";
import { market } from "../src/market";

describe("socketAddress", () => {
  it("turns the page's scheme into a socket's, and keeps a socket's", () => {
    const page = "https://example.com/app/";
    expect(socketAddress("/api/live", page).href).toBe(
      "wss://example.com/api/live",
    );
    expect(socketAddress("/api/live", "http://localhost:5173/").href).toBe(
      "ws://localhost:5173/api/live",
    );
    expect(socketAddress("wss://feed.example.com/live", page).href).toBe(
      "wss://feed.example.com/live",
    );
    expect(socketAddress("ws://127.0.0.1:9000/", page).href).toBe(
      "ws://127.0.0.1:9000/",
    );
  });
});

describe("liveFeed on a cache of its own", () => {
  const stops: (() => void)[] = [];
  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
  });

  /** A connected tab on a dedicated worker, whose reads fail when told. */
  function dedicatedTab(failing: () => boolean) {
    const reads: Range[] = [];
    const get = vi.fn(async (range: Range) => {
      reads.push(range);
      const misses = failing()
        ? [{ range, reason: "fetch-failed" as const }]
        : [];
      return { misses } as unknown as GetResult;
    });
    const client = { mode: "dedicated" } as TscacheClient;
    const connection = {
      state: { status: "connected", client },
      cache: async () => ({ get }),
    } as unknown as Connection;
    return { connection, reads };
  }

  it("reads again from where its own read of a poll failed", async () => {
    let failing = true;
    const { connection, reads } = dedicatedTab(() => failing);
    const drawn: Range[] = [];
    stops.push(
      liveFeed({
        connection,
        config: market,
        // A source that brings nothing: the polls below come as from
        // another tab holding the feed.
        source: () => () => {},
        onBatch: (span) => drawn.push(span),
        onOpened: () => {},
      }),
    );
    // The holder's polls, as it passes them on.
    const holder = new BroadcastChannel(`tscache-reference:feed:${market.id}`);
    stops.push(() => holder.close());
    holder.postMessage({
      kind: "polled",
      span: { start: 59_000, end: 61_000 },
    });
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    failing = false;
    holder.postMessage({
      kind: "polled",
      span: { start: 61_000, end: 63_000 },
    });
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    // The failed span is read again with the next one.
    expect(reads[1]).toEqual({ start: 59_000, end: 63_000 });
    holder.postMessage({
      kind: "polled",
      span: { start: 63_000, end: 65_000 },
    });
    await vi.waitFor(() => expect(reads).toHaveLength(3));
    expect(reads[2]).toEqual({ start: 63_000, end: 65_000 });
    expect(drawn.at(-1)).toEqual({ start: 63_000, end: 65_000 });
  });
});
