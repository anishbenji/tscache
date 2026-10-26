// The client-only page: render the markup, then start the page.

import { pageMarkup, startPage } from "./page";
import "./style.css";

const root = document.getElementById("app");
if (root === null) throw new Error("index.html has no #app");
root.innerHTML = pageMarkup("loading…");
startPage(root);
