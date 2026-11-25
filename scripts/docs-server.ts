// Server for the Playwright docs project (e2e/docs/): serves the built
// documentation site, site/.vitepress/dist (`bun run docs:build`), under the
// site's base, /tscache/, on 127.0.0.1 only. It stands in for `vitepress
// preview`, which listens on every interface and has no option to bind one.
// Bun only; no dependency.
//
// It answers as the published site does: the site sets `cleanUrls`, so
// /tscache/guide/demo is guide/demo.html and /tscache/how-it-works/ is
// how-it-works/index.html; any other path is the site's 404 page.

import { stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(
  new URL("../site/.vitepress/dist/", import.meta.url),
);
const base = "/tscache/";
const port = Number(process.env.DOCS_PORT ?? 5300);

/** The files a path below the base may be, in the order they are tried. */
function candidates(path: string): string[] {
  if (path === "" || path.endsWith("/")) return [`${path}index.html`];
  return [path, `${path}.html`, `${path}/index.html`];
}

/** The built file at `relative`, or undefined when it is outside the site. */
function inSite(relative: string): string | undefined {
  const file = resolve(dist, relative);
  return file.startsWith(dist) || `${file}${sep}` === dist ? file : undefined;
}

/** Whether `file` is a file (not a directory, not missing). */
async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function serve(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname.startsWith(base)) {
    let path: string;
    try {
      path = decodeURIComponent(pathname.slice(base.length));
    } catch {
      return new Response("bad request", { status: 400 });
    }
    for (const relative of candidates(path)) {
      const file = inSite(relative);
      if (file === undefined) break;
      if (await isFile(file)) return new Response(Bun.file(file));
    }
  }
  const missing = `${dist}404.html`;
  return new Response(
    (await isFile(missing)) ? Bun.file(missing) : "not found",
    {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
    },
  );
}

// Without a build there is nothing to check: exit at once, naming the cause,
// rather than answer 404 until Playwright's wait for the server times out.
if (!(await isFile(`${dist}index.html`))) {
  console.error(
    "docs server: the site is not built (no site/.vitepress/dist/index.html); run bun run docs:build first",
  );
  process.exit(1);
}

Bun.serve({ port, hostname: "127.0.0.1", fetch: serve });
console.log(`docs server on http://127.0.0.1:${port}${base}`);
