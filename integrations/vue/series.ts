// tscache in Vue: a plugin that gives the app one connection
// (shared/connection.ts), and a composable that turns the cache's answer for
// a range into refs. The composable starts everything live in onMounted,
// which Vue never calls on the server (a server render never unmounts, so a
// subscription made in setup would outlive it). A server render therefore
// subscribes to nothing, and a hydration render changes no ref, so it
// shows what the server rendered. A change to the cache over the range on
// screen, from any tab, reads it again, at most once per frame
// (shared/changes.ts).

import type {
  CacheConfig,
  GetResult,
  Range,
  TscacheClient,
} from "@anishbenji/tscache";
import {
  type InjectionKey,
  inject,
  type MaybeRefOrGetter,
  onMounted,
  onScopeDispose,
  onWatcherCleanup,
  type Plugin,
  type ShallowRef,
  shallowReadonly,
  shallowRef,
  toRaw,
  toValue,
  watch,
} from "vue";
import { ViewReads } from "../shared/changes";
import { type Connection, connect, type Seed } from "../shared/connection";

/** The cache's answer for a range. */
export interface Answer {
  range: Range;
  result: GetResult;
}

/** The app's connection, as {@link createTscache} provides it. */
export const CONNECTION: InjectionKey<Connection> = Symbol("tscache");

/**
 * A plugin that connects once for the app and disposes the connection when
 * the app unmounts. `open` runs once per client, so it can read the
 * fetcher's current credentials; `seeds`, the server's reads, go to every
 * client. Install it in the browser only; a server render reads
 * with its own client (ssr-server.ts).
 */
export function createTscache(
  open: () => Promise<TscacheClient>,
  seeds?: readonly Seed[],
): Plugin {
  return (app) => {
    const connection = connect(open, seeds);
    app.provide(CONNECTION, connection);
    app.onUnmount(() => connection.dispose());
  };
}

/** What {@link useSeries} gives a component, as readonly refs. */
export interface Series {
  /** The answer for the latest range; the previous one while it loads. */
  answer: Readonly<ShallowRef<Answer | undefined>>;
  /** Whether the answer for the latest range is still on its way. */
  pending: Readonly<ShallowRef<boolean>>;
  /**
   * Why the latest range could not be read, or why the client could not
   * connect; cleared by the next answer. A lost worker is not an error,
   * since the client that replaces it reads again.
   */
  error: Readonly<ShallowRef<unknown>>;
}

/**
 * The cache's answer for `range`, read again when the range changes, when
 * a new client replaces one whose worker was lost, and when the cache
 * changes over the range (from the cache alone, or with a fetch after a
 * change that wrote nothing; architecture §2.7). Only the answer for
 * the latest range lands. Move the range by giving a new object (a
 * shallowRef suits it): a range changed in place is not seen.
 *
 * `initial`, the server's read, is the answer until the browser's own
 * arrives, so the hydration render matches the server's markup. The answer
 * holds the cache's typed arrays as they are: a shallowRef never makes them
 * reactive.
 */
export function useSeries(
  config: CacheConfig,
  range: MaybeRefOrGetter<Range>,
  initial?: Answer,
): Series {
  // Absent in a server render, which installs no plugin.
  const connection = inject<Connection | null>(CONNECTION, null);
  const answer = shallowRef(initial);
  const pending = shallowRef(initial === undefined);
  const error = shallowRef<unknown>();

  onMounted(() => {
    if (connection === null) {
      throw new Error("useSeries needs app.use(createTscache(open))");
    }
    const state = shallowRef(connection.state);
    onScopeDispose(
      connection.subscribe(() => {
        state.value = connection.state;
      }),
    );
    const changed = shallowRef(0);
    // Holds a change during a fetching read, keeps failure labels, and
    // releases after the answer landed (shared/changes.ts).
    const views = new ViewReads({
      shown: () => toRaw(toValue(range)),
      interval: config.interval,
      reread: () => {
        changed.value++;
      },
    });
    onScopeDispose(() => views.dispose());
    watch(
      [state, () => toValue(range), changed],
      ([current, asked]) => {
        if (current.status === "failed") {
          error.value = current.error;
          pending.value = false;
          return;
        }
        if (current.status === "connecting") {
          pending.value = true;
          return;
        }
        let latest = true;
        onWatcherCleanup(() => {
          latest = false;
        });
        // A worker cannot be posted a reactive proxy, as ref() makes one.
        const plain = toRaw(asked);
        const read = views.read(
          connection.cache(current.client, config),
          plain,
          current,
        );
        // A read after a change keeps the answer it replaces as current.
        if (!read.cacheOnly) pending.value = true;
        read.answer.then(
          (result) => {
            if (!latest) return;
            answer.value = { range: plain, result };
            error.value = undefined;
            pending.value = false;
          },
          (failure: unknown) => {
            // A lost worker rejects what was pending; the connection's
            // next client reads again, so only a failure on a live client
            // counts.
            if (!latest || connection.state !== current) return;
            error.value = failure;
            pending.value = false;
          },
        );
      },
      { immediate: true },
    );
  });

  return {
    answer: shallowReadonly(answer),
    pending: shallowReadonly(pending),
    error: shallowReadonly(error),
  };
}
