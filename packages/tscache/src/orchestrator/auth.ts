/**
 * Auth state (docs/architecture.md §2.5, §4.9; designs b and y): a fetch
 * that throws AuthInvalidError flips the state to invalid and every tab
 * hears it once; nothing is fetched until updateAuth flips it back.
 */

import type { Evt } from "../rpc/protocol";

export class AuthState {
  readonly #broadcast: (evt: Evt) => void;
  #valid = true;
  /** Gets waiting on fetches; told once when auth flips to invalid. */
  readonly #waiters = new Set<() => void>();

  constructor(broadcast: (evt: Evt) => void) {
    this.#broadcast = broadcast;
  }

  /**
   * Calls `fn` once if auth flips to invalid; returns the unsubscribe, which
   * the waiter must call when its fetches finish so nothing accumulates.
   */
  onInvalid(fn: () => void): () => void {
    // Already invalid (a fetch may have failed synchronously before the
    // waiter subscribed): tell it now, nothing to hold.
    if (!this.#valid) {
      fn();
      return () => {};
    }
    this.#waiters.add(fn);
    return () => this.#waiters.delete(fn);
  }

  /** Gets currently waiting on fetches (diagnostics and tests). */
  get waiterCount(): number {
    return this.#waiters.size;
  }

  get valid(): boolean {
    return this.#valid;
  }

  /** Flips to invalid; broadcasts authInvalid only on the first flip. */
  invalidate(error: { name: string; message: string }): void {
    if (!this.#valid) return;
    this.#valid = false;
    // Release gets that are waiting on fetches: they report auth-pending.
    for (const fn of [...this.#waiters]) fn();
    this.#waiters.clear();
    this.#broadcast({
      t: "evt",
      scope: "client",
      event: "authInvalid",
      payload: { error },
    });
  }

  /** New material arrived: fetches may resume. */
  restore(): void {
    this.#valid = true;
  }
}
