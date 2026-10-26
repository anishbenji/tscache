// The client-only page: render the markup, then start the page.

import { pageMarkup, startPage } from "./page";
import "@reference/shared/style.css";

const root = document.getElementById("app");
if (root === null) throw new Error("index.html has no #app");
root.innerHTML = pageMarkup("loading…");
const teardown = startPage(root);
// In dev, an edit re-runs this module: end the old page first.
import.meta.hot?.dispose(teardown);
