/**
 * Client-side event surface (docs/architecture.md §2.7, N5): evt messages
 * from the port become typed ClientEvents; the fallback chain adds its own
 * modeFallback. Reuses the engine's emitter.
 */

import { Emitter } from "../engine/emitter";
import type { Evt } from "../rpc/protocol";
import type { ClientEvents } from "../types";

/** The event names of each wire scope that this client re-emits (§2.7). */
const NAMES: Record<Evt["scope"], readonly (keyof ClientEvents)[]> = {
  cache: ["cacheCleared", "persistStopped", "cacheChanged"],
  request: ["mergeWarning"],
  // `superseded` reaches here through the client, at most once and with
  // its property already set (N113).
  client: ["authInvalid", "superseded"],
};

export class ClientEmitter extends Emitter<ClientEvents> {
  /** Re-emits a wire event under its typed name; unknown names are ignored. */
  receive(evt: Evt): void {
    // Own properties only: a scope from another release names no list.
    const names = Object.hasOwn(NAMES, evt.scope) ? NAMES[evt.scope] : [];
    const name = names.find((known) => known === evt.event);
    if (name !== undefined) this.emit(name, evt.payload as never);
  }
}
