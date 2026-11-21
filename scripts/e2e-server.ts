// Server for the Playwright suite: serves the built package from
// packages/tscache/dist under /dist, the fixture pages from e2e/pages, the
// columns decoder the fixture fetcher imports (/columns.js) and the mock
// backend under /backend. Workers need a same-origin URL, so the tests
// cannot load files directly. Bun only; no dependency.
//
// For the deploy-skew suite (e2e/deploy-skew.spec.ts) it also serves a
// second generation of everything a tab loads, without a second build: the
// fixture fetcher under a second URL (/fetcher-b.js), a fetcher whose
// contents a test swaps (/backend/<ns>/fetcher.js, scripts/e2e-backend.ts),
// and the built package as a later library version (/dist-next/, with the
// fixture page at /next/).

import { backend, columnsModule } from "./e2e-backend";

const root = new URL("..", import.meta.url);
const port = Number(process.env.E2E_PORT ?? 4173);

/** The library version /dist-next/ reports: above any real one. */
const NEXT_VERSION = "99.0.0";

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
  // The same module under a second URL: another generation key (N126).
  if (pathname === "/fetcher-b.js") return "e2e/pages/fetcher.js";
  return `e2e/pages${pathname === "/" ? "/index.html" : pathname}`;
}

/** A text file of the repository with `from` replaced by `to` throughout. */
async function rewritten(
  path: string,
  from: string,
  to: string,
): Promise<Response> {
  const file = Bun.file(new URL(path, root));
  if (!(await file.exists())) {
    return new Response("not found", { status: 404 });
  }
  const text = (await file.text()).replaceAll(from, to);
  return new Response(text, { headers: { "content-type": contentType(path) } });
}

/**
 * The built package as a later library version: every file of dist/ with
 * the package's version literal replaced, so that a page loading
 * /dist-next/index.js and its worker at /dist-next/worker.js are a
 * generation with a higher `LIB_VERSION` (N126, N128).
 */
async function nextLibrary(pathname: string): Promise<Response> {
  const manifest = (await Bun.file(
    new URL("packages/tscache/package.json", root),
  ).json()) as { version: string };
  return rewritten(
    `packages/tscache/dist/${pathname.slice("/dist-next/".length)}`,
    JSON.stringify(manifest.version),
    JSON.stringify(NEXT_VERSION),
  );
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
  // The fixture page of the later library version.
  "/next/": () => rewritten("e2e/pages/index.html", "/dist/", "/dist-next/"),
};

function generatedFor(pathname: string) {
  return Object.hasOwn(generated, pathname) ? generated[pathname] : undefined;
}

/** Path prefixes answered by code: the mock backend, the later library. */
const prefixed: [
  string,
  (request: Request, url: URL) => Response | Promise<Response>,
][] = [
  ["/backend/", backend],
  ["/dist-next/", (_request, url) => nextLibrary(url.pathname)],
];

/** A file of dist/ or of the fixture pages, or 404. */
async function staticFile(pathname: string): Promise<Response> {
  const path = fileFor(pathname);
  const file = Bun.file(new URL(path, root));
  if (!(await file.exists())) {
    return new Response("not found", { status: 404 });
  }
  return new Response(file, { headers: { "content-type": contentType(path) } });
}

function serve(request: Request): Response | Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  const answer =
    generatedFor(pathname) ??
    prefixed.find(([prefix]) => pathname.startsWith(prefix))?.[1];
  return answer === undefined ? staticFile(pathname) : answer(request, url);
}

// The backend holds requests until a test releases them; Bun's default idle
// timeout (10 s) would cut such a request off, so it is disabled.
Bun.serve({ port, hostname: "127.0.0.1", idleTimeout: 0, fetch: serve });
console.log(`e2e server on http://127.0.0.1:${port}/`);
