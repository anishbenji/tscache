/**
 * Client-side event surface (docs/architecture.md §2.7, N5): evt messages
 * from the port become typed ClientEvents; the fallback chain adds its own
 * modeFallback. Reuses the engine's emitter.
 */

import { Emitter } from "../engine/emitter";
import type { Evt } from "../rpc/protocol";
import type { ClientEvents } from "../types";

export class ClientEmitter extends Emitter<ClientEvents> {
  /** Re-emits a wire event under its typed name; unknown names are ignored. */
  receive(evt: Evt): void {
    switch (evt.scope) {
      case "cache":
        if (evt.event === "cacheCleared") {
          this.emit(
            "cacheCleared",
            evt.payload as ClientEvents["cacheCleared"],
          );
        }
        return;
      case "request":
        if (evt.event === "mergeWarning") {
          this.emit(
            "mergeWarning",
            evt.payload as ClientEvents["mergeWarning"],
          );
        }
        return;
      case "client":
        if (evt.event === "authInvalid") {
          this.emit("authInvalid", evt.payload as ClientEvents["authInvalid"]);
        }
        return;
      default:
        return;
    }
  }
}
