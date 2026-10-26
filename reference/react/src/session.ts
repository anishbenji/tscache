// The session's state in React. The session lives outside React, where
// app-lifetime things belong: StrictMode runs effects twice, and an effect
// would start a second session. Its state reaches components through
// useSyncExternalStore, which re-renders them on each change and never
// tears a render across two states.

import type { Session, SessionState } from "@reference/shared/session";
import { useSyncExternalStore } from "react";

const unsubscribed = () => () => {};

/**
 * The session's state. `initial` is the state the page starts in, which
 * the server renders and the browser's hydration render reproduces; on the
 * server there is no session.
 */
export function useSessionState(
  session: Session | null,
  initial: SessionState,
): SessionState {
  return useSyncExternalStore(
    session?.subscribe ?? unsubscribed,
    () => session?.state ?? initial,
    () => initial,
  );
}
