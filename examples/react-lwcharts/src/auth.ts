// The tab's view of authentication. authInvalid reaches every tab with the
// refused fetcher context (N33); the refresh snippet then rotates the tokens
// once, under a Web Lock, and every tab adopts them. A get never waits for
// that: while auth is invalid it answers at once, with the unfetched ranges
// as 'auth-pending' misses, and the next get after updateAuth is complete.

import { useCallback, useEffect, useReducer } from "react";
import type { GetResult, TscacheClient } from "tscache";
import { refreshOnAuthInvalid } from "./auth-refresh";
import { log, message } from "./log";
import {
  accessOf,
  loadTokens,
  refreshTokens,
  saveTokens,
  short,
  signIn,
  toContext,
} from "./tokens";

/**
 * 'pending' from an authInvalid or an answer with auth-pending misses until
 * a complete answer; 'lost' when the snippet gave up and the user must sign
 * in again.
 */
type AuthStatus = "ok" | "pending" | "lost";

interface AuthState {
  status: AuthStatus;
  /** authInvalid events this tab heard. */
  heard: number;
}

type AuthAction =
  | { type: "invalid" }
  | { type: "answered"; complete: boolean }
  | { type: "lost" }
  | { type: "signedIn" };

function reduce(state: AuthState, action: AuthAction): AuthState {
  const pending = state.status === "lost" ? "lost" : "pending";
  switch (action.type) {
    case "invalid":
      return { status: pending, heard: state.heard + 1 };
    case "answered":
      // A complete answer proves the fetcher is authorized again, whichever
      // tab signed in.
      return { ...state, status: action.complete ? "ok" : pending };
    case "lost":
      return { ...state, status: "lost" };
    case "signedIn":
      return { ...state, status: "pending" };
  }
}

function isComplete(result: GetResult): boolean {
  return !result.misses.some((miss) => miss.reason === "auth-pending");
}

/** Installs the refresh snippet on `client` and tracks what it does. */
function installRefresh(
  client: TscacheClient,
  dispatch: (action: AuthAction) => void,
): () => void {
  return refreshOnAuthInvalid(client, {
    load: loadTokens,
    save: saveTokens,
    refresh: async (token) => {
      const tokens = await refreshTokens(token);
      log(`refreshed the tokens; this tab held the lock (${short(token)})`);
      return tokens;
    },
    toContext,
    accessOf,
    onSessionLost: (error) => {
      log(`session lost: ${message(error)}`);
      dispatch({ type: "lost" });
    },
  });
}

export interface Auth {
  status: AuthStatus;
  heard: number;
  /** Records a get's answer: complete, or with auth-pending misses. */
  answered: (result: GetResult) => void;
  signInAgain: () => Promise<void>;
}

export function useAuth(client: TscacheClient | undefined): Auth {
  const [state, dispatch] = useReducer(reduce, { status: "ok", heard: 0 });
  useEffect(() => {
    if (client === undefined) return;
    const uninstall = installRefresh(client, dispatch);
    const unlisten = client.on("authInvalid", ({ context }) => {
      log(`authInvalid: the backend refused ${short(accessOf(context))}`);
      dispatch({ type: "invalid" });
    });
    return () => {
      uninstall();
      unlisten();
    };
  }, [client]);
  const answered = useCallback((result: GetResult) => {
    dispatch({ type: "answered", complete: isComplete(result) });
  }, []);
  const signInAgain = useCallback(async () => {
    if (client === undefined) return;
    try {
      const { access } = await signIn();
      await client.updateAuth(toContext(access));
      log("signed in again");
      dispatch({ type: "signedIn" });
    } catch (error) {
      log(`sign-in failed: ${message(error)}`);
    }
  }, [client]);
  return { ...state, answered, signInAgain };
}
