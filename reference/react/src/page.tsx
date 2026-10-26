// The page's lifetime in React: the session starts before the first render
// and ends after the root unmounts, outside React, so it lives exactly as
// long as the page, whatever StrictMode mounts twice.

import { chartKindOf } from "@reference/shared/chart/load";
import { startSession } from "@reference/shared/session";
import type { ServerRead } from "@tscache/integrations/shared/hydration";
import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { App } from "./App";
import { openClient } from "./client";

/**
 * Renders the page into `element`, or hydrates the server's markup there
 * when `served` is the server's read. Returns the teardown: it unmounts
 * the root, then ends the session (its client, the live feed's lock and
 * channel, the credential listeners). A page that simply closes needs
 * none, since a client disposes itself on `pagehide`.
 */
export function startPage(
  element: HTMLElement,
  served?: ServerRead,
): () => Promise<void> {
  const session = startSession({ open: openClient, served });
  const app = (
    <StrictMode>
      <App
        session={session}
        served={served}
        initialKind={chartKindOf(location.search)}
      />
    </StrictMode>
  );
  const root =
    served === undefined ? createRoot(element) : hydrateRoot(element, app);
  if (served === undefined) root.render(app);
  return async () => {
    root.unmount();
    await session.dispose();
  };
}
