import { vi } from "vitest";
import type { WorkersChannel } from "../src/rpc/workers-channel";

/**
 * A fake of the origin's BroadcastChannels (the real one is removed for
 * this package's tests, setup-channel.ts). As a real one, a message is
 * cloned and reaches every other channel of the same name that is open
 * when it is posted, never the sender. Delivery is synchronous, the
 * hardest order for a receiver, unless the test holds it and delivers one
 * message at a time.
 */
export function fakeChannels(): {
  /** A channel of the bus, as `new BroadcastChannel(name)` gives one. */
  open(name?: string): WorkersChannel & { closed: boolean };
  /** Installs the bus as `globalThis.BroadcastChannel`. */
  install(): void;
  /** Every message posted, in order. */
  posts: Record<string, unknown>[];
  /** How many channels were opened, and how many of them are still open. */
  counts: { opened: number; open: number };
  /** From now on messages wait until `deliver`. */
  hold(): void;
  /** Delivers the oldest held message, or all of them. */
  deliver(all?: boolean): void;
} {
  type Listener = (event: { data?: unknown }) => void;
  interface Channel extends WorkersChannel {
    name: string;
    closed: boolean;
    listeners: Listener[];
  }
  const channels = new Set<Channel>();
  const posts: Record<string, unknown>[] = [];
  const counts = { opened: 0, open: 0 };
  let held: (() => void)[] | undefined;

  function open(name = "tscache-workers"): Channel {
    const channel: Channel = {
      name,
      closed: false,
      listeners: [],
      postMessage(message) {
        if (channel.closed) throw new Error("channel closed");
        const data = structuredClone(message) as Record<string, unknown>;
        posts.push(data);
        // The subscribers at the post, as BroadcastChannel has it.
        const targets = [...channels].filter(
          (other) => other !== channel && other.name === name,
        );
        const send = () => {
          for (const target of targets) {
            if (target.closed) continue;
            for (const listener of [...target.listeners]) {
              listener({ data: structuredClone(data) });
            }
          }
        };
        if (held === undefined) send();
        else held.push(send);
      },
      addEventListener(_type, listener) {
        channel.listeners.push(listener);
      },
      close() {
        if (channel.closed) return;
        channel.closed = true;
        channels.delete(channel);
        counts.open--;
      },
    };
    channels.add(channel);
    counts.opened++;
    counts.open++;
    return channel;
  }

  return {
    open,
    install() {
      vi.stubGlobal(
        "BroadcastChannel",
        // A constructor that returns the fake: `new` yields that object.
        function FakeBroadcastChannel(name: string) {
          return open(name);
        },
      );
    },
    posts,
    counts,
    hold() {
      held ??= [];
    },
    deliver(all = false) {
      const queue = held ?? [];
      do queue.shift()?.();
      while (all && queue.length > 0);
    },
  };
}
