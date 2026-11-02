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
 * once. A call still pending at the deadline is abandoned, and no call
 * starts after it.
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
  let late = false;

  const attempts = async (store: PersistStore): Promise<void> => {
    try {
      for (;;) {
        if (late) return;
        try {
          await store.clearAll();
          return;
        } catch {
          // Retried below while the retry is due before the deadline.
        }
        if (performance.now() + debounceMs >= deadline) return;
        await new Promise((retry) => setTimeout(retry, debounceMs));
      }
    } finally {
      store.close();
    }
  };

  return new Promise((resolve) => {
    const timer = setTimeout(
      () => {
        late = true;
        resolve();
      },
      Math.max(0, deadline - performance.now()),
    );
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    new Promise<PersistStore | undefined>((opened) =>
      opened(openStore({ ifExists: true })),
    )
      .then((store) => (store === undefined ? undefined : attempts(store)))
      .then(done, done);
  });
}
