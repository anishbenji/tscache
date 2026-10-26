// The server-rendered page, the browser's half: hydrate the server's
// markup from the same read, and start the session's cache from it, so
// the browser fetches only what that read did not cover (the forming bar).

import { chartKindOf } from "@reference/shared/chart/load";
import { market } from "@reference/shared/market";
import { startSession } from "@reference/shared/session";
import {
  type Dehydrated,
  readJson,
  rehydrate,
  SERVER_READ,
} from "@tscache/integrations/shared/hydration";
import { StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { App } from "./App";
import { openClient } from "./client";
import "@reference/shared/style.css";

const element = document.getElementById("app");
if (element === null) throw new Error("ssr.html has no #app");
const served = rehydrate(market, readJson<Dehydrated>(SERVER_READ));
const session = startSession({ open: openClient, served });
hydrateRoot(
  element,
  <StrictMode>
    <App
      session={session}
      served={served}
      initialKind={chartKindOf(location.search)}
    />
  </StrictMode>,
);
