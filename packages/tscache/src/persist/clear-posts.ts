/**
 * When a hosting's `clearAll` is posted to the other workers of the origin
 * (docs/architecture.md §4.10.7, §4.10.8; N116). A `clearAll` of the hosting
 * itself is posted twice: in the synchronous step that clears its memory,
 * and when its disk clear has settled. A `clearAll` run on behalf of a
 * channel message is relayed once, when its disk clear settles, and never
 * again for that clear id.
 *
 * The posting itself is the entry's (`post`); this module only decides when
 * to post and remembers the clear ids it has seen.
 */

import { randomId } from "../random-id";

export interface ClearPostOptions {
  /**
   * Posts a clear id on the workers' channel. Called, never awaited; an
   * error it throws is ignored. Without it nothing is posted.
   */
  post?: (clearId: string) => void;
  /** A new id for a `clearAll` of this hosting. Default: a random id. */
  nextClearId?: () => string;
}

/**
 * How many clear ids a hosting remembers. Forgetting one costs at most one
 * more relay post for it, and it is forgotten only after this many other
 * `clearAll` calls reached the hosting, so relays cannot sustain themselves.
 */
const SEEN_CLEAR_IDS = 64;

const nothing = (): void => {};

export class ClearPosts {
  readonly #post: ((clearId: string) => void) | undefined;
  readonly #nextClearId: () => string;
  /** The clear ids seen last, this hosting's own included; oldest first. */
  readonly #seen = new Set<string>();

  constructor(options: ClearPostOptions) {
    this.#post = options.post;
    this.#nextClearId = options.nextClearId ?? randomId;
  }

  /**
   * A `clearAll` has cleared memory, in this synchronous step. Without
   * `fromClearId` it is the hosting's own: it gets a new clear id, which is
   * posted now. Returns what the caller runs once the disk clear has
   * settled, on any path: the second post of an own clear, or the one relay
   * post of a clear id first seen now.
   */
  begin(fromClearId?: string): () => void {
    if (this.#post === undefined) return nothing;
    const own = fromClearId === undefined;
    const clearId = own ? this.#nextClearId() : fromClearId;
    const relayed = this.#seen.has(clearId);
    this.#remember(clearId);
    if (own) this.#send(clearId);
    else if (relayed) return nothing;
    return () => this.#send(clearId);
  }

  #remember(clearId: string): void {
    if (this.#seen.has(clearId)) return;
    this.#seen.add(clearId);
    if (this.#seen.size <= SEEN_CLEAR_IDS) return;
    for (const oldest of this.#seen) {
      this.#seen.delete(oldest);
      return;
    }
  }

  /** A channel that fails must not fail or delay this hosting's clear. */
  #send(clearId: string): void {
    try {
      this.#post?.(clearId);
    } catch {
      // Other workers miss this post; the clear here goes on.
    }
  }
}
