// The tokens every tab of the origin shares, kept in localStorage, and the
// mock backend's sign-in and refresh endpoints. The fetcher context carries
// only the access token; the refresh token never leaves the page.

import type { ExampleContext } from "@examples/mock-backend/fetcher";
import type { StoredTokens } from "./auth-refresh";

const KEY = "tscache-example:tokens";

function json(text: string | null): unknown {
  try {
    return text === null ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

function parse(text: string | null): StoredTokens | undefined {
  const value = json(text);
  if (typeof value !== "object" || value === null) return undefined;
  const { access, refresh } = value as Record<string, unknown>;
  if (typeof access !== "string") return undefined;
  if (typeof refresh !== "string" && refresh !== null) return undefined;
  return { access, refresh };
}

/** The shared tokens; throws when no tab is signed in. */
export function loadTokens(): StoredTokens {
  const tokens = parse(localStorage.getItem(KEY));
  if (tokens === undefined) throw new Error("no tab is signed in");
  return tokens;
}

export function saveTokens(tokens: StoredTokens): void {
  localStorage.setItem(KEY, JSON.stringify(tokens));
}

async function post(path: string, body?: unknown): Promise<Response> {
  const response = await fetch(path, {
    method: "POST",
    body: JSON.stringify(body ?? {}),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return response;
}

/** Clears the stored tokens, signs in and stores the new ones for every tab. */
export async function signIn(): Promise<StoredTokens> {
  localStorage.removeItem(KEY);
  const tokens = (await (await post("/api/auth/login")).json()) as StoredTokens;
  saveTokens(tokens);
  return tokens;
}

/** The stored tokens, or a new sign-in when there are none. */
export async function currentTokens(): Promise<StoredTokens> {
  return parse(localStorage.getItem(KEY)) ?? signIn();
}

/** Exchanges a refresh token for new tokens; each works once. */
export async function refreshTokens(
  refresh: string,
): Promise<{ access: string; refresh: string }> {
  return (await post("/api/auth/refresh", { refresh })).json();
}

export function toContext(access: string): ExampleContext {
  return { token: access };
}

export function accessOf(context: unknown): string | undefined {
  return (context as ExampleContext | undefined)?.token;
}

/** A short form of a token for the log. */
export function short(token: string | undefined): string {
  return token === undefined ? "none" : `${token.slice(0, 11)}…`;
}
