// The session's state in Solid. The session lives outside Solid, for as
// long as the page (page.tsx); its state reaches components through one
// signal, which each change replaces with the session's new state. Every
// expression that reads it updates on its own; nothing else re-runs.

import type { Session, SessionState } from "@reference/shared/session";
import { type Accessor, createSignal, onSettled } from "solid-js";

/**
 * The session's state. `initial` is the state the page starts in, which the
 * server renders and the browser's hydration render reproduces; once the
 * page has settled (hydration done), the session's state takes over. On the
 * server there is no session, and nothing settles.
 */
export function createSessionState(
  session: Session | null,
  initial: SessionState,
): Accessor<SessionState> {
  const [state, setState] = createSignal(initial);
  onSettled(() => {
    if (session === null) return;
    const take = () => setState(session.state);
    take();
    const unsubscribe = session.subscribe(take);
    return () => {
      unsubscribe();
    };
  });
  return state;
}
