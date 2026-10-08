/**
 * Auth state (docs/architecture.md §2.5, §4.9; designs b and y): a fetch
 * that throws AuthInvalidError flips the state to invalid and every tab
 * hears it once; nothing is fetched until updateAuth flips it back.
 */

import type { Evt } from "../rpc/protocol";

export class AuthState {
  readonly #broadcast: (evt: Evt) => void;
  #valid = true;
  #invalidated: Promise<void>;
  #signalInvalid: () => void = () => {};

  constructor(broadcast: (evt: Evt) => void) {
    this.#broadcast = broadcast;
    this.#invalidated = this.#arm();
  }

  /** A promise that settles on the next flip to invalid. */
  get whenInvalid(): Promise<void> {
    return this.#invalidated;
  }

  #arm(): Promise<void> {
    return new Promise((resolve) => {
      this.#signalInvalid = resolve;
    });
  }

  get valid(): boolean {
    return this.#valid;
  }

  /** Flips to invalid; broadcasts authInvalid only on the first flip. */
  invalidate(error: { name: string; message: string }): void {
    if (!this.#valid) return;
    this.#valid = false;
    // Release gets that are waiting on fetches: they report auth-pending.
    this.#signalInvalid();
    this.#broadcast({
      t: "evt",
      scope: "client",
      event: "authInvalid",
      payload: { error },
    });
  }

  /** New material arrived: fetches may resume. */
  restore(): void {
    if (this.#valid) return;
    this.#valid = true;
    this.#invalidated = this.#arm();
  }
}
