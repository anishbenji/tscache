/**
 * The clear-only database call of the hostings that do not persist
 * (docs/architecture.md §4.10.7, N66): the dedicated-worker and in-process
 * hostings have no persister, yet their `clearAll` must empty what a
 * SharedWorker session stored, so a logout from any hosting leaves no
 * stored data behind. Part of the lazily loaded persistence chunk
 * (`persist/lazy.ts`), imported at the first `clearAll`.
 */

import type { OpenStore } from "./hosted";
import type { PersistStore } from "./store";

export interface ClearDiskOptions {
  /** Delay before a rejected clear is tried again. Default 1000 ms. */
  debounceMs?: number;
  /** The clear's one deadline, from `startedAt` (N61). Default 5000 ms. */
  timeoutMs?: number;
  /** When the clear was asked for (`performance.now()`); default now. */
  startedAt?: number;
}

/**
 * Empties the database, as the persister's `clearAll` job does (§4.10.6),
 * without a persister: opens it only if it exists (`ifExists`, so a browser
 * without one gets none), runs `store.clearAll()` (every record, strict),
 * and closes the connection. A rejected clear is retried after
 * `debounceMs` while the retry is due before the deadline, `timeoutMs`
 * after `startedAt`; a database that fails to open fails the clear at
 * once. A call still pending at the deadline is abandoned.
 *
 * No disk operation starts at or after the deadline: the opening and every
 * attempt check the clock first, since the deadline's timer may run after a
 * late continuation (a chunk imported late, a database opened at the
 * deadline). Every connection that opens is closed exactly once: when the
 * call ends, also at the deadline with an attempt still pending, or, for a
 * database that opens after the end, as soon as it opens.
 *
 * Resolves once the disk is empty, or once the clear has failed, at the
 * latest at the deadline. Never rejects: a hosting that persists nothing
 * has nothing to stop (N66).
 */
export function clearDisk(
  openStore: OpenStore,
  options: ClearDiskOptions = {},
): Promise<void> {
  const debounceMs = options.debounceMs ?? 1000;
  const timeoutMs = options.timeoutMs ?? 5000;
  const deadline = (options.startedAt ?? performance.now()) + timeoutMs;
  const due = () => performance.now() < deadline;

  return new Promise((resolve) => {
    let ended = false;
    let store: PersistStore | undefined;
    // The one end of the call: closes the connection it holds, if any.
    const end = () => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      store?.close();
      resolve();
    };

    const run = async (): Promise<void> => {
      if (!due()) return;
      const opened = await openStore({ ifExists: true });
      if (opened === undefined) return;
      if (ended || !due()) {
        // Opened after the end, or at the deadline: closed unused.
        opened.close();
        return;
      }
      store = opened;
      for (;;) {
        try {
          await opened.clearAll();
          return;
        } catch {
          // Retried below while the retry is due before the deadline.
        }
        if (performance.now() + debounceMs >= deadline) return;
        await new Promise((retry) => setTimeout(retry, debounceMs));
        if (ended || !due()) return;
      }
    };

    const timer = setTimeout(end, Math.max(0, deadline - performance.now()));
    run().then(end, end);
  });
}
