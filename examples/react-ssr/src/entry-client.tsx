// The page's browser side: hydrates the server's markup from the props the
// server rendered it with, and hands the server's read to the browser's
// cache (src/session.ts).

import { readHydration, readJson } from "@examples/mock-backend/hydration";
import { StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { APP_PROPS, App, type AppProps } from "./App";

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root");
hydrateRoot(
  root,
  <StrictMode>
    <App {...readJson<AppProps>(APP_PROPS)} hydration={readHydration()} />
  </StrictMode>,
);
