// Static server for the Playwright suite: serves the built package from
// packages/tscache/dist under /dist and the fixture pages from e2e/pages.
// Workers need a same-origin URL, so the tests cannot load files directly.
// Bun only; no dependency.

const root = new URL("..", import.meta.url);
const port = Number(process.env.E2E_PORT ?? 4173);

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".map": "application/json",
};

Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(request) {
    const { pathname } = new URL(request.url);
    const path = pathname.startsWith("/dist/")
      ? `packages/tscache/dist/${pathname.slice("/dist/".length)}`
      : `e2e/pages${pathname === "/" ? "/index.html" : pathname}`;
    const file = Bun.file(new URL(path, root));
    if (!(await file.exists()))
      return new Response("not found", { status: 404 });
    const ext = path.slice(path.lastIndexOf("."));
    return new Response(file, {
      headers: { "content-type": types[ext] ?? "application/octet-stream" },
    });
  },
});
console.log(`e2e server on http://127.0.0.1:${port}/`);
