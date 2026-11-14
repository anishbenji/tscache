// The demo recorder's ownership stack (scripts/demo/record.ts). Each
// cleanup is registered when its resource is acquired, so releasing undoes
// exactly what was acquired: an exit before a resource existed undoes
// nothing for it.
//
// A resource can be acquired after release has begun: an await that
// started before (a browser context being created, say) finishes after.
// Such a resource is stopped at once and released by the same release,
// which drains the stack until it is empty, so it is never left behind.

/** A cleanup, registered when its resource was acquired. */
interface Owned {
  /** Undoes the resource; awaited, newest first. */
  release(): unknown;
  /** Runs synchronously as release begins, before anything is awaited. */
  stop?(): void;
}

export class Owner {
  /** What is owned and not yet released, oldest first. */
  readonly #owned: Owned[] = [];
  /** Set as release begins, before any release runs. */
  #begun = false;
  #releasing: Promise<void> | undefined;

  /** True once `releaseAll` has been called. */
  get releasing(): boolean {
    return this.#begun;
  }

  /**
   * Registers the cleanup of a resource just acquired; returns the call that
   * removes it once the resource is released the ordinary way. Once release
   * has begun, `stop` runs at once and the release that is draining the
   * stack takes the resource too.
   */
  own(release: () => unknown, stop?: () => void): () => void {
    const entry: Owned = stop === undefined ? { release } : { release, stop };
    this.#owned.push(entry);
    if (this.#begun) entry.stop?.();
    return () => {
      const at = this.#owned.indexOf(entry);
      if (at !== -1) this.#owned.splice(at, 1);
    };
  }

  /**
   * Runs every `stop`, newest first and synchronously, then releases what is
   * owned, newest first, each on its own (one that fails does not keep the
   * rest), until nothing is left, including anything owned meanwhile. The
   * same promise for every caller.
   */
  releaseAll(): Promise<void> {
    if (this.#releasing !== undefined) return this.#releasing;
    this.#begun = true;
    for (const entry of [...this.#owned].reverse()) entry.stop?.();
    this.#releasing = (async () => {
      for (
        let entry = this.#owned.pop();
        entry !== undefined;
        entry = this.#owned.pop()
      ) {
        try {
          await entry.release();
        } catch {
          // The resource is gone already, or its owner is: the rest still go.
        }
      }
    })();
    return this.#releasing;
  }
}
