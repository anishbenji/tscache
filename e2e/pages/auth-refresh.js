// Refresh-token rotation across tabs, driven by tscache's authInvalid event.
//
// tscache tells every open tab when the fetcher reports an expired token.
// With refresh-token rotation each refresh token works once: if every tab
// refreshed, all but the first would present a spent token, and many servers
// answer that by revoking the whole session. Here one tab refreshes while
// the others wait on a Web Lock; a tab that gets the lock afterwards finds
// the tokens already replaced and uses them instead of refreshing again.

/**
 * @param client the tscache client of this tab
 * @param options.load returns the tokens all tabs share, `{ access, refresh }`
 *   (from localStorage, say); may return a promise
 * @param options.save stores new tokens where `load` finds them
 * @param options.refresh exchanges a refresh token for new tokens; a failure
 *   rejects unhandled, so catch it here to send the user to sign in
 * @param options.toContext builds the fetcher context for an access token
 * @returns the unsubscribe function
 */
export function refreshOnAuthInvalid(
  client,
  { load, save, refresh, toContext, lockName = "tscache-auth-refresh" },
) {
  // The access token this tab last saw: the one that has just been refused.
  let seen = Promise.resolve(load()).then((tokens) => tokens.access);
  return client.on("authInvalid", () => {
    void navigator.locks.request(lockName, async () => {
      let tokens = await load();
      if (tokens.access === (await seen)) {
        tokens = await refresh(tokens.refresh);
        await save(tokens);
      }
      seen = Promise.resolve(tokens.access);
      // Tabs sharing a SharedWorker would recover from one tab's update, but
      // tabs on their own workers (after a fallback) each need theirs.
      await client.updateAuth(toContext(tokens.access));
    });
  });
}
