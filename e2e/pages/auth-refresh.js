// Refresh-token rotation across tabs, driven by tscache's authInvalid event.
//
// tscache tells every open tab when the fetcher reports an expired token.
// With refresh-token rotation each refresh token works once: if every tab
// refreshed, all but the first would present a spent token, and many servers
// answer that by revoking the whole session. Here one tab refreshes while
// the others wait on a Web Lock; a tab that gets the lock afterwards finds
// the tokens already replaced and uses them instead of refreshing again.
//
// A refresh token is never presented twice: it is cleared from storage
// before it is spent, so if the refresh or the save of the new tokens fails,
// every tab ends the session through onSessionLost instead of retrying with
// it.
//
// Known limit: the event does not say which token was refused, so a tab
// takes it to be the one it last handed to its client. An event about an
// older token that arrives after the tab adopted a newer one therefore
// rotates once more than needed. That rotation presents the current refresh
// token, so it is wasteful but safe.

/**
 * @param client the tscache client of this tab
 * @param options.access the access token in the context this client was
 *   created with
 * @param options.load returns the tokens all tabs share, `{ access, refresh }`
 *   (from localStorage, say); may return a promise
 * @param options.save stores tokens where `load` finds them; may return a
 *   promise, which must reject if they were not stored
 * @param options.refresh exchanges a refresh token for new tokens
 * @param options.toContext builds the fetcher context for an access token
 * @param options.onSessionLost called with the error when the session cannot
 *   be recovered (send the user to sign in)
 * @returns the unsubscribe function
 */
export function refreshOnAuthInvalid(
  client,
  {
    access,
    load,
    save,
    refresh,
    toContext,
    onSessionLost,
    lockName = "tscache-auth-refresh",
  },
) {
  // The access token this tab last handed to its client.
  let seen = access;
  return client.on("authInvalid", () => {
    // The token known when the event fired, before any recovery queued ahead
    // of this one replaces it.
    const refused = seen;
    void navigator.locks
      .request(lockName, async () => {
        let tokens;
        try {
          tokens = await load();
          if (tokens.refresh === null) {
            throw new Error("the session ended in another tab");
          }
          if (tokens.access === refused) {
            await save({ access: tokens.access, refresh: null });
            tokens = await refresh(tokens.refresh);
            await save(tokens);
          }
        } catch (error) {
          onSessionLost(error);
          return;
        }
        seen = tokens.access;
        // Tabs sharing a SharedWorker would recover from one tab's update,
        // but tabs on their own workers (after a fallback) each need theirs.
        await client.updateAuth(toContext(tokens.access));
      })
      .catch(reportError);
  });
}
