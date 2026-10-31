// Server for the Playwright suite: serves the built package from
// packages/tscache/dist under /dist, the fixture pages from e2e/pages, the
// columns decoder the fixture fetcher imports (/columns.js) and the mock
// backend under /backend. Workers need a same-origin URL, so the tests
// cannot load files directly. Bun only; no dependency.

import { backend, columnsModule } from "./e2e-backend";

const root = new URL("..", import.meta.url);
const port = Number(process.env.E2E_PORT ?? 4173);

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".map": "application/json",
};

/** URL path → repository-relative file path. */
function fileFor(pathname: string): string {
  if (pathname.startsWith("/dist/")) {
    return `packages/tscache/dist/${pathname.slice("/dist/".length)}`;
  }
  return `e2e/pages${pathname === "/" ? "/index.html" : pathname}`;
}

function contentType(path: string): string {
  return types[path.slice(path.lastIndexOf("."))] ?? "application/octet-stream";
}

/** Paths answered by code rather than from a file. */
const generated: Record<string, () => Response | Promise<Response>> = {
  // Readiness probe for Playwright's webServer: 200 even before any fixture
  // page exists (a 404 would never count as "up").
  "/healthz": () => new Response("ok"),
  "/columns.js": columnsModule,
};

function generatedFor(pathname: string) {
  return Object.hasOwn(generated, pathname) ? generated[pathname] : undefined;
}

async function serve(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  const answer = generatedFor(pathname);
  if (answer !== undefined) return answer();
  if (pathname.startsWith("/backend/")) return backend(request, url);
  const path = fileFor(pathname);
  const file = Bun.file(new URL(path, root));
  if (!(await file.exists())) {
    return new Response("not found", { status: 404 });
  }
  return new Response(file, { headers: { "content-type": contentType(path) } });
}

// The backend holds requests until a test releases them; Bun's default idle
// timeout (10 s) would cut such a request off, so it is disabled.
Bun.serve({ port, hostname: "127.0.0.1", idleTimeout: 0, fetch: serve });
console.log(`e2e server on http://127.0.0.1:${port}/`);
