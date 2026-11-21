/**
 * The channel the SharedWorkers of an origin share (docs/architecture.md
 * §4.7, §4.10.7; N108, N116), and the post of the hostings that only post
 * their `clearAll` on it. The SharedWorker's own part, the announcements
 * and the rank, is `generations.ts`.
 *
 * No DOM references: the channel is looked up at call time, and a realm
 * without `BroadcastChannel` simply has none.
 */

import { randomId } from "../random-id";

/** The channel's name; the origin's, so the same partition as the database. */
const WORKERS_CHANNEL = "tscache-workers";

/** The part of `BroadcastChannel` used here. */
export interface WorkersChannel {
  postMessage(message: unknown): void;
  addEventListener(
    type: "message",
    listener: (event: { data?: unknown }) => void,
  ): void;
  close(): void;
}

/** A `clearAll` on the channel: `id` is the sender's, `clear` the clear id. */
export type ClearAll = { t: "clearAll"; v: 1; id: string; clear: string };

/** The origin's workers channel, or undefined without `BroadcastChannel`. */
export function openWorkersChannel(): WorkersChannel | undefined {
  const Channel = (
    globalThis as { BroadcastChannel?: new (name: string) => WorkersChannel }
  ).BroadcastChannel;
  if (typeof Channel !== "function") return undefined;
  try {
    return new Channel(WORKERS_CHANNEL);
  } catch {
    return undefined;
  }
}

/**
 * The `post` of a hosting that only posts its `clearAll` (N116, N119): the
 * dedicated worker and the in-process hosting. It opens the channel at a
 * clear's first post and closes it after its second, so a page that never
 * calls `clearAll` never holds a channel. Undefined in a realm without
 * `BroadcastChannel`.
 */
export function clearPoster(): ((clearId: string) => void) | undefined {
  const scope = globalThis as { BroadcastChannel?: unknown };
  if (typeof scope.BroadcastChannel !== "function") return undefined;
  const id = randomId();
  const open = new Map<string, WorkersChannel>();
  return (clearId) => {
    const held = open.get(clearId);
    const channel = held ?? openWorkersChannel();
    if (channel === undefined) return;
    if (held === undefined) open.set(clearId, channel);
    else open.delete(clearId);
    const message: ClearAll = { t: "clearAll", v: 1, id, clear: clearId };
    try {
      channel.postMessage(message);
    } finally {
      if (held !== undefined) channel.close();
    }
  };
}
