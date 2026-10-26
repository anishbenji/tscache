// The server-rendered page, the browser's half: hydrate the server's
// markup from the same read, and start the session's cache from it, so
// the browser fetches only what that read did not cover (the forming bar).

import { market } from "@reference/shared/market";
import {
  type Dehydrated,
  readJson,
  rehydrate,
  SERVER_READ,
} from "@tscache/integrations/shared/hydration";
import { startPage } from "./page";
import "@reference/shared/style.css";

const element = document.getElementById("app");
if (element === null) throw new Error("ssr.html has no #app");
const teardown = startPage(
  element,
  rehydrate(market, readJson<Dehydrated>(SERVER_READ)),
);
// In dev, an edit re-runs this module: end the old page first.
import.meta.hot?.dispose(teardown);
