// The client-only page. The session starts before the first render and
// ends after the root unmounts, so it lives as long as the page, whatever
// React mounts twice in StrictMode.

import { chartKindOf } from "@reference/shared/chart/load";
import { startSession } from "@reference/shared/session";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { openClient } from "./client";
import "@reference/shared/style.css";

const element = document.getElementById("app");
if (element === null) throw new Error("index.html has no #app");
const session = startSession({ open: openClient });
createRoot(element).render(
  <StrictMode>
    <App session={session} initialKind={chartKindOf(location.search)} />
  </StrictMode>,
);
