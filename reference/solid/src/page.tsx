// The page's lifetime in Solid: the session starts before the first render
// and ends after the root is disposed, outside Solid, so it lives exactly as
// long as the page.

import { chartKindOf } from "@reference/shared/chart/load";
import { startSession } from "@reference/shared/session";
import { hydrate, render } from "@solidjs/web";
import type { ServerRead } from "@tscache/integrations/shared/hydration";
import { App } from "./App";
import { openClient } from "./client";

/**
 * Renders the page into `element`, or hydrates the server's markup there
 * when `served` is the server's read. Returns the teardown: it disposes the
 * root, then ends the session (its client, the live feed's lock and
 * channel, the credential listeners). A page that simply closes needs
 * none, since a client disposes itself on `pagehide`.
 */
export function startPage(
  element: HTMLElement,
  served?: ServerRead,
): () => Promise<void> {
  const session = startSession({ open: openClient, served });
  const app = () => (
    <App
      session={session}
      served={served}
      initialKind={chartKindOf(location.search)}
    />
  );
  const dispose =
    served === undefined ? render(app, element) : hydrate(app, element);
  return async () => {
    dispose();
    await session.dispose();
  };
}
