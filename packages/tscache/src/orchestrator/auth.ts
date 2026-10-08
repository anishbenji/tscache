/**
 * Auth state (docs/architecture.md §2.5, §4.9; designs b and y): a fetch
 * that throws AuthInvalidError flips the state to invalid and every tab
 * hears it once; nothing is fetched until updateAuth flips it back.
 */

import type { Evt } from "../rpc/protocol";

export class AuthState {
  readonly #broadcast: (evt: Evt) => void;
  #valid = true;

  constructor(broadcast: (evt: Evt) => void) {
    this.#broadcast = broadcast;
  }

  get valid(): boolean {
    return this.#valid;
  }

  /** Flips to invalid; broadcasts authInvalid only on the first flip. */
  invalidate(error: { name: string; message: string }): void {
    if (!this.#valid) return;
    this.#valid = false;
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
