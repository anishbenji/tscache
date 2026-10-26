// Credentials for the fetcher, and their refresh across tabs.
//
// The fetcher runs in tscache's worker and sends the access token it finds
// in its context. When the backend refuses it, the fetcher throws
// AuthInvalidError, and tscache tells every tab with authInvalid, naming
// the refused context (N33). Reads do not wait meanwhile: they answer with
// 'auth-pending' misses, so a tab reads again once it has new credentials.
//
// With refresh-token rotation each refresh token works once; if every tab
// refreshed, all but the first would present a spent token, and many
// servers answer that by revoking the session. So one tab refreshes, under
// a Web Lock, and a tab that gets the lock after it finds the refused token
// already replaced and adopts the new one. A refresh token is cleared from
// storage before it is spent, so a failed refresh ends the session in
// every tab instead of being retried with it.
//
// It assumes a refresh issues a new access token (N42). A backend that
// renews a token in place returns the refused string again, so each tab
// that heard the refusal finds it still stored and refreshes once in
// turn: every refresh presents the current refresh token, never a spent
// one, so the session survives, at the cost of one redundant refresh per
// extra tab.
//
// The tokens live in localStorage, which every tab of the origin shares.
// Only the access token goes into the fetcher's context; the refresh token
// never leaves the page.

import type { ExampleContext } from "@examples/mock-backend/fetcher";
import type { TscacheClient } from "tscache";

interface Tokens {
  access: string;
  /** null once spent, until the refresh that spent it stores the next. */
  refresh: string | null;
}

const KEY = "tscache-reference:tokens";
const LOCK = "tscache-reference:auth-refresh";

function parse(text: string | null): Tokens | undefined {
  let value: unknown;
  try {
    value = text === null ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const { access, refresh } = value as Record<string, unknown>;
  if (typeof access !== "string") return undefined;
  if (typeof refresh !== "string" && refresh !== null) return undefined;
  return { access, refresh };
}

function load(): Tokens | undefined {
  return parse(localStorage.getItem(KEY));
}

function save(tokens: Tokens): void {
  localStorage.setItem(KEY, JSON.stringify(tokens));
}

async function post(path: string, body: unknown): Promise<Tokens> {
  const response = await fetch(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return (await response.json()) as Tokens;
}

/** Signs in and stores the tokens for every tab. */
async function signIn(): Promise<Tokens> {
  localStorage.removeItem(KEY);
  const tokens = await post("/api/auth/login", {});
  save(tokens);
  return tokens;
}

function contextOf(access: string): ExampleContext {
  return { token: access };
}

/**
 * The fetcher context for a new client: the stored access token, or a new
 * sign-in when no tab has signed in. Pass it as `fetcher.context` to
 * createClient.
 */
export async function fetcherContext(): Promise<ExampleContext> {
  return contextOf((load() ?? (await signIn())).access);
}

export interface RefreshOptions {
  /** The client has new credentials: read again what came back auth-pending. */
  onRefreshed(): void;
  /** The session cannot be recovered: ask the user to sign in again. */
  onSessionLost(error: unknown): void;
}

/**
 * Refreshes `client`'s credentials on authInvalid, at most once across
 * tabs per refused token. Returns the unsubscribe.
 */
export function refreshOnAuthInvalid(
  client: TscacheClient,
  { onRefreshed, onSessionLost }: RefreshOptions,
): () => void {
  return client.on("authInvalid", ({ context }) => {
    const refused = (context as ExampleContext | undefined)?.token;
    void navigator.locks
      .request(LOCK, async () => {
        let tokens: Tokens;
        try {
          const stored = load();
          if (stored === undefined || stored.refresh === null) {
            throw new Error("the session ended in another tab");
          }
          tokens = stored;
          // Otherwise another tab already replaced the refused token. A
          // worker too old to name it (refused undefined) gets a refresh.
          if (refused === undefined || tokens.access === refused) {
            save({ access: tokens.access, refresh: null });
            tokens = await post("/api/auth/refresh", {
              refresh: stored.refresh,
            });
            save(tokens);
          }
        } catch (error) {
          onSessionLost(error);
          return;
        }
        // Tabs sharing a SharedWorker would recover from one tab's update,
        // but tabs on workers of their own (after a fallback) need theirs.
        await client.updateAuth(contextOf(tokens.access));
        onRefreshed();
      })
      .catch(reportError);
  });
}

/**
 * Calls `listener` with the new fetcher context when another tab stores
 * tokens that can be refreshed: a sign-in, or a rotation. A tab whose
 * session was lost recovers so without signing in itself. Returns the
 * unsubscribe.
 */
export function onTokensStored(
  listener: (context: ExampleContext) => void,
): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== KEY) return;
    const tokens = parse(event.newValue);
    if (tokens?.refresh != null) listener(contextOf(tokens.access));
  };
  addEventListener("storage", onStorage);
  return () => removeEventListener("storage", onStorage);
}

/** Signs in again after a lost session and gives `client` the new token. */
export async function signInAgain(client: TscacheClient): Promise<void> {
  const { access } = await signIn();
  await client.updateAuth(contextOf(access));
}
