// tscache in Svelte 5. The page owns the connection (shared/connection.ts)
// and hands it to the app as root context when it mounts or hydrates it; a
// Series is a runes class that holds the cache's answer for a range. Effects
// do not run on the server, so a server render, which has no connection,
// shows the answer it was given and reads nothing.

import { getContext } from "svelte";
import { createSubscriber } from "svelte/reactivity";
import type {
  CacheConfig,
  CacheHandle,
  GetResult,
  Range,
  TscacheClient,
} from "tscache";
import type { Connection, ConnectionState } from "../shared/connection";

const CONNECTION = Symbol("tscache connection");

/** The app's connection, with a `state` that effects and templates track. */
class TrackedConnection {
  readonly #connection: Connection;
  readonly #changes: () => void;

  constructor(connection: Connection) {
    this.#connection = connection;
    // Subscribed only while something reads `state`, once however many do.
    this.#changes = createSubscriber((update) => connection.subscribe(update));
  }

  get state(): ConnectionState {
    this.#changes();
    return this.#connection.state;
  }

  cache(client: TscacheClient, config: CacheConfig): Promise<CacheHandle> {
    return this.#connection.cache(client, config);
  }
}

/**
 * The `context` option of `mount()` or `hydrate()` for an app whose series
 * read through `connection`. A server render passes none.
 */
export function tscacheContext(connection: Connection): Map<symbol, unknown> {
  return new Map([[CONNECTION, new TrackedConnection(connection)]]);
}

/** The cache's answer for a range. */
export interface Answer {
  range: Range;
  result: GetResult;
}

/**
 * The cache's answer for `range`, read again whenever `range` changes and
 * whenever a new client replaces one whose worker was lost. Create it while
 * a component initialises, since it reads the app's context and owns an
 * effect, which ends with the component.
 */
export class Series {
  /** The range to show. Setting it reads the cache for it. */
  range: Range;
  #answer: Answer | undefined;
  #failure = $state.raw<{ error: unknown }>();
  #reads = 0;

  /**
   * `shown` is the answer to show until the first read lands, such as the
   * server's read of `range` in a server-rendered page.
   */
  constructor(config: CacheConfig, range: Range, shown?: Answer) {
    this.range = $state.raw(range);
    this.#answer = $state.raw(shown);
    const connection = getContext<TrackedConnection | undefined>(CONNECTION);
    $effect(() => {
      if (connection === undefined) {
        throw new Error(
          "the app has no tscache connection; mount it with tscacheContext()",
        );
      }
      const state = connection.state;
      const range = this.range;
      if (state.status === "failed") {
        this.#failure = { error: state.error };
        return;
      }
      if (state.status !== "connected") return;
      // Checked when the read settles. The count tells this read from a
      // later one for the same range object (A, B, A). The range covers the
      // microtask between a change of `range` and Svelte re-running this
      // effect, when this read is still the last one started.
      const read = ++this.#reads;
      const latest = () => read === this.#reads && this.range === range;
      connection
        .cache(state.client, config)
        .then((cache) => cache.get(range))
        .then(
          (result) => {
            if (latest()) this.#answer = { range, result };
          },
          (error: unknown) => {
            // A lost worker rejects what was pending; the connection's next
            // client reads again, so only a failure on a live client counts.
            if (latest() && connection.state === state) {
              this.#failure = { error };
            }
          },
        );
    });
  }

  /**
   * The answer for `range`, or while it loads the answer before; undefined
   * until the first. Throws what failed, the read or the connection, so a
   * `<svelte:boundary>` around the markup that reads it shows the failure.
   */
  get current(): Answer | undefined {
    if (this.#failure !== undefined) throw this.#failure.error;
    return this.#answer;
  }

  /** Whether the answer shown is for an earlier range, or there is none yet. */
  get loading(): boolean {
    return this.#answer?.range !== this.range;
  }
}
