// The client-only page.

import { startPage } from "./page";
import "@reference/shared/style.css";

const element = document.getElementById("app");
if (element === null) throw new Error("index.html has no #app");
const teardown = startPage(element);
// In dev, an edit re-runs this module: end the old page first.
import.meta.hot?.dispose(teardown);
