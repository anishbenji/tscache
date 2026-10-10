/**
 * The worker's lifetime lock (docs/architecture.md §4.8, N32). Chromium runs
 * a SharedWorker in the renderer of the tab that created it, and a crash of
 * that renderer kills the worker without telling the other tabs. The worker
 * therefore holds a Web Lock until its global goes away; a client queued on
 * that lock is granted it only then. No DOM references: the Web Locks API is
 * looked up at call time and passed in.
 */

/** The part of the Web Locks API (`navigator.locks`) used here. */
export interface LockManagerLike {
  request(
    name: string,
    options: { mode: "exclusive" | "shared"; signal?: AbortSignal },
    callback: () => unknown,
  ): Promise<unknown>;
}

/** `navigator.locks` where this realm has Web Locks (secure contexts only). */
export function lockManager(): LockManagerLike | undefined {
  const scope = globalThis as {
    navigator?: { locks?: Partial<LockManagerLike> };
  };
  const locks = scope.navigator?.locks;
  return typeof locks?.request === "function"
    ? (locks as LockManagerLike)
    : undefined;
}

/**
 * Takes an exclusive lock under a fresh name and keeps it until this realm
 * ends. Resolves with the name once the lock is held, or with undefined when
 * there is no lock to hold (no Web Locks, or the request was refused); never
 * rejects.
 */
export function holdLifetimeLock(
  locks: LockManagerLike | undefined,
): Promise<string | undefined> {
  if (locks === undefined) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    try {
      const name = `tscache-worker:${crypto.randomUUID()}`;
      locks
        .request(name, { mode: "exclusive" }, () => {
          resolve(name);
          // Never settles: the lock goes only with this realm.
          return new Promise(() => {});
        })
        .catch(() => resolve(undefined));
    } catch {
      resolve(undefined);
    }
  });
}

/**
 * Queues on the lifetime lock `name` in shared mode. The grant means its
 * holder is gone: `onGone` runs once, unless `signal` was aborted first.
 * Aborting `signal` withdraws the request. A request the browser refuses
 * leaves nothing to watch.
 */
export function watchLifetimeLock(
  locks: LockManagerLike,
  name: string,
  signal: AbortSignal,
  onGone: () => void,
): void {
  try {
    locks
      .request(name, { mode: "shared", signal }, () => {
        if (!signal.aborted) onGone();
      })
      // Withdrawn by the signal (AbortError) or refused: nothing to report.
      .catch(() => {});
  } catch {
    // A synchronous refusal: likewise nothing to watch.
  }
}
