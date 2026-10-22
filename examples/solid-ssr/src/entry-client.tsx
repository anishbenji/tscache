// Hydrates the server's markup with the props it was rendered from, so the
// first render in the browser writes exactly what the server wrote.

import { readJson } from "@examples/mock-backend/hydration";
import { hydrate } from "@solidjs/web";
import { APP_PROPS, App } from "./App";
import type { ServerRead } from "./sensor";

const root = document.getElementById("app");
if (root === null) throw new Error("the page has no #app element");
const props = readJson<ServerRead>(APP_PROPS);
hydrate(() => <App {...props} />, root);
