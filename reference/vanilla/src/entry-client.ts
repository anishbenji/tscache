// The server-rendered page, the browser's half: take over the server's
// markup and start the cache from the server's read, so the browser
// fetches only what that read did not cover (the forming bar, say).

import { market } from "@reference/shared/market";
import {
  type Dehydrated,
  readJson,
  rehydrate,
  SERVER_READ,
} from "@tscache/integrations/shared/hydration";
import { startPage } from "./page";
import "@reference/shared/style.css";

const root = document.getElementById("app");
if (root === null) throw new Error("ssr.html has no #app");
startPage(root, {
  served: rehydrate(market, readJson<Dehydrated>(SERVER_READ)),
});
