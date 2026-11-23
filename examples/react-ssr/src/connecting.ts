// How the page's client connects, apart from React and Vite's browser-only
// imports, so unit tests can drive it (test/connecting.test.ts): one
// attempt at a time, the next started when an attempt's worker is lost, and
// a lost or stopped attempt's result dropped.

/** What one connection attempt is given. */
export interface Attempt {
  /** Ends this attempt, as its worker was lost, and starts the next. */
  lose(reason: string): void;
  /**
   * Whether this attempt still counts: its worker not lost and the attempts
   * not stopped. One that no longer counts says nothing of its seeding, and
   * its result is dropped.
   */
  live(): boolean;
}

/** What the attempts report. */
export interface Outcomes<T> {
  /** A live attempt connected. */
  connected(result: T): void;
  /** An attempt's worker was lost before the attempts were stopped. */
  lost(reason: string): void;
  /** An attempt failed to connect. */
  failed(error: unknown): void;
  /** Releases the result of an attempt that no longer counts. */
  drop(result: T): void;
}

/**
 * Starts `connect`, and starts it again each time an attempt's worker is
 * lost, until the returned function stops it. A lost attempt's seeding no
 * longer fails it (mock-backend's `seedCache` counts a failure as not
 * seeded), so it may still resolve: its result goes to `drop`, never to
 * `connected`, so a lost client never replaces the one connected after it.
 */
export function attempts<T>(
  connect: (attempt: Attempt) => Promise<T>,
  on: Outcomes<T>,
): () => void {
  let stopped = false;
  const next = () => {
    let lost = false;
    const attempt: Attempt = {
      lose(reason) {
        lost = true;
        if (stopped) return;
        on.lost(reason);
        next();
      },
      live: () => !stopped && !lost,
    };
    connect(attempt).then(
      (result) => {
        if (attempt.live()) on.connected(result);
        else on.drop(result);
      },
      (error: unknown) => on.failed(error),
    );
  };
  next();
  return () => {
    stopped = true;
  };
}
