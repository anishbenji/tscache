/**
 * The client's `cacheChanged` subscriptions (docs/architecture.md §2.7,
 * §4.8; N74, N80): listeners are counted per key, every cache or one cache,
 * and the first listener of a key sends `subscribe`, the release of the
 * last one `unsubscribe`. Both are fire-and-forget, so `on` stays
 * synchronous; posted at once, they precede any read sent after them on the
 * same port ("subscribe, then read").
 */

import type { PortClient } from "../rpc/port-client";
import { warnMissingFeature } from "./dev";

/** What a subscription names, as the ops take it. */
export type ChangeTarget = { cacheId: string } | { all: true };

export class ChangeSubscriptions {
  readonly #port: PortClient;
  /** Listener counts: `'*'` for every cache, `'c:' + cacheId` for one. */
  readonly #counts = new Map<string, number>();
  #warned = false;

  constructor(port: PortClient) {
    this.#port = port;
  }

  /** Counts one listener of `target`; returns its release, which is idempotent. */
  hold(target: ChangeTarget): () => void {
    const key = "all" in target ? "*" : `c:${target.cacheId}`;
    const count = (this.#counts.get(key) ?? 0) + 1;
    this.#counts.set(key, count);
    if (count === 1) this.#send("subscribe", target);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      const left = (this.#counts.get(key) ?? 1) - 1;
      if (left > 0) {
        this.#counts.set(key, left);
        return;
      }
      this.#counts.delete(key);
      this.#send("unsubscribe", target);
    };
  }

  /**
   * Posts the op when the worker offers the feature. Without it nothing is
   * posted, and a development build warns once per client (N80).
   */
  #send(op: "subscribe" | "unsubscribe", target: ChangeTarget): void {
    if (!this.#port.features.has("cacheChanged")) {
      if (op === "subscribe" && !this.#warned) {
        this.#warned = true;
        warnMissingFeature("cacheChanged");
      }
      return;
    }
    // Rejects only once the client is disposed or its worker lost, when
    // the connection and its subscriptions are gone anyway.
    this.#port.request(op, target).catch(() => {});
  }
}
