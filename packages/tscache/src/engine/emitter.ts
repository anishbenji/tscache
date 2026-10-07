/**
 * Minimal typed emitter for engine events (docs/architecture.md §4.6).
 * Lives under engine/ because the engine must not import client/.
 */

type Listener<T> = (payload: T) => void;

export class Emitter<Events extends object> {
  readonly #listeners = new Map<keyof Events, Set<Listener<never>>>();

  /** Subscribes; returns the matching unsubscribe. */
  on<E extends keyof Events>(event: E, fn: Listener<Events[E]>): () => void {
    let set = this.#listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(fn as Listener<never>);
    return () => this.off(event, fn);
  }

  off<E extends keyof Events>(event: E, fn: Listener<Events[E]>): void {
    this.#listeners.get(event)?.delete(fn as Listener<never>);
  }

  /**
   * Calls the listeners subscribed at the start of the call: additions and
   * removals during an emit apply from the next one. A throwing listener
   * does not stop the others; the first error is rethrown after all ran.
   */
  emit<E extends keyof Events>(event: E, payload: Events[E]): void {
    const set = this.#listeners.get(event);
    if (set === undefined) return;
    let failure: { error: unknown } | undefined;
    for (const fn of [...set]) {
      try {
        (fn as Listener<Events[E]>)(payload);
      } catch (error) {
        failure ??= { error };
      }
    }
    if (failure !== undefined) throw failure.error;
  }
}
