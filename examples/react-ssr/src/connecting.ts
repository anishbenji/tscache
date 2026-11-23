// How the page's client connects, apart from React and Vite's browser-only
// imports, so unit tests can drive it (test/connecting.test.ts): one
// attempt at a time, the next started when an attempt's worker is lost, and
// a lost or stopped attempt's result dropped; and the seeding of a cache
// from the server's snapshot.

import type { CacheHandle, Range } from "@anishbenji/tscache";
import { type Hydration, seed } from "@examples/mock-backend/hydration";
import { message } from "./log";

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
 * longer fails it (`seedCache` counts a failure as not seeded), so it may
 * still resolve: its result goes to `drop`, never to `connected`, so a lost
 * client never replaces the one connected after it.
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

/**
 * Applies the server's snapshot to `cache` and returns the ranges it
 * filled, or undefined when the snapshot was not applied. A snapshot that
 * fails to apply (a malformed or foreign one, a failed write) only means
 * the cache is not seeded: hydration saves fetches, it is never needed for
 * correct answers (architecture §2.8), so the cache fetches those ranges
 * instead. A development build says why, with the error's message only
 * (the snapshot carries the page's data), and only while `live` holds: a
 * lost or disposed client fails every pending call, `hydrate` included, and
 * that is no news about the snapshot.
 */
export async function seedCache(
  cache: CacheHandle,
  hydration: Hydration,
  live: () => boolean,
): Promise<Range[] | undefined> {
  try {
    return (await seed(cache, hydration)).applied;
  } catch (error) {
    if (import.meta.env.DEV && live()) {
      console.warn(
        `tscache: the server's snapshot for cache "${cache.id}" was not applied (${message(error)}), so the cache fetches that range instead; printed in development builds only.`,
      );
    }
    return undefined;
  }
}
