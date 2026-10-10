// Refresh-token rotation across tabs, driven by tscache's authInvalid event.
//
// tscache tells every open tab when the fetcher reports an expired token,
// and names the fetcher context that was refused. With refresh-token
// rotation each refresh token works once: if every tab refreshed, all but
// the first would present a spent token, and many servers answer that by
// revoking the whole session. Here one tab refreshes while the others wait
// on a Web Lock; a tab that gets the lock afterwards finds the refused token
// already replaced and uses the new tokens instead of refreshing again.
//
// A refresh token is never presented twice: it is cleared from storage
// before it is spent, so if the refresh or the save of the new tokens fails,
// every tab ends the session through onSessionLost instead of retrying with
// it.

/**
 * @param client the tscache client of this tab
 * @param options.load returns the tokens all tabs share, `{ access, refresh }`
 *   (from localStorage, say); may return a promise
 * @param options.save stores tokens where `load` finds them; may return a
 *   promise, which must reject if they were not stored
 * @param options.refresh exchanges a refresh token for new tokens
 * @param options.toContext builds the fetcher context for an access token
 * @param options.accessOf returns the access token in a fetcher context
 *   (the inverse of `toContext`)
 * @param options.onSessionLost called with the error when the session cannot
 *   be recovered (send the user to sign in)
 * @returns the unsubscribe function
 */
export function refreshOnAuthInvalid(
  client,
  {
    load,
    save,
    refresh,
    toContext,
    accessOf,
    onSessionLost,
    lockName = "tscache-auth-refresh",
  },
) {
  return client.on("authInvalid", ({ context }) => {
    void navigator.locks
      .request(lockName, async () => {
        let tokens;
        try {
          const refused = accessOf(context);
          tokens = await load();
          if (tokens.refresh === null) {
            throw new Error("the session ended in another tab");
          }
          // Otherwise another tab already replaced the refused token.
          if (tokens.access === refused) {
            await save({ access: tokens.access, refresh: null });
            tokens = await refresh(tokens.refresh);
            await save(tokens);
          }
        } catch (error) {
          onSessionLost(error);
          return;
        }
        // Tabs sharing a SharedWorker would recover from one tab's update,
        // but tabs on their own workers (after a fallback) each need theirs.
        await client.updateAuth(toContext(tokens.access));
      })
      .catch(reportError);
  });
}
