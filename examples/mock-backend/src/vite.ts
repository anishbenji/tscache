// Vite plugins for the examples: one mounts the mock backend on the dev and
// preview servers, so each example runs from a single command; one gives the
// URL of a fetcher module, which tscache's worker import()s; and one renders
// the SSR examples' page on the server.

/// <reference path="./node.d.ts" />

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isRunnableDevEnvironment, type Plugin } from "vite";
import { type BackendOptions, createBackend } from "./backend";

// The parts of Node's request and response the adapter uses; declared here
// so the examples need no Node type definitions.
interface NodeRequest extends AsyncIterable<Uint8Array<ArrayBuffer>> {
  method?: string | undefined;
  url?: string | undefined;
  headers: Record<string, string | string[] | undefined>;
}

interface NodeResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: Uint8Array): void;
}

type Middleware = (
  req: NodeRequest,
  res: NodeResponse,
  next: (error?: unknown) => void,
) => void;

function toHeaders(raw: NodeRequest["headers"]): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    for (const item of [value ?? []].flat()) headers.append(name, item);
  }
  return headers;
}

async function toRequest(req: NodeRequest): Promise<Request> {
  const headers = toHeaders(req.headers);
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers });
  }
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for await (const chunk of req) chunks.push(chunk);
  return new Request(url, { method, headers, body: new Blob(chunks) });
}

async function send(res: NodeResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => {
    res.setHeader(name, value);
  });
  res.end(new Uint8Array(await response.arrayBuffer()));
}

/** Serves the mock backend under /api/ on `vite` and `vite preview`. */
export function mockBackend(options?: BackendOptions): Plugin {
  const backend = createBackend(options);
  const middleware: Middleware = (req, res, next) => {
    if (!req.url?.startsWith("/api/")) return next();
    toRequest(req)
      .then(backend)
      .then((response) => (response ? send(res, response) : next()))
      .catch(next);
  };
  return {
    name: "tscache-examples:mock-backend",
    configureServer: (server) => void server.middlewares.use(middleware),
    configurePreviewServer: (server) => void server.middlewares.use(middleware),
  };
}

const FETCHER_QUERY = "?fetcher";
const PREFIX = "\0fetcher-url:";

/**
 * `import url from "./fetcher.ts?fetcher"` gives the URL of that module
 * with its exports intact. Vite's `?worker&url` does not fit: it bundles a
 * worker entry without exports, and tscache needs the fetcher's default
 * export. In a build the module becomes its own chunk; in dev it is served
 * from source.
 *
 * Server code (the SSR examples' in-process client) gets a URL it can
 * import() too: in a server build, a file URL of the chunk; in dev, the
 * same path as the browser, which Vite's module runner resolves.
 */
export function fetcherUrl(): Plugin {
  let serve = false;
  const chunks = new Set<string>();
  return {
    name: "tscache-examples:fetcher-url",
    enforce: "pre",
    configResolved(config) {
      serve = config.command === "serve";
    },
    async resolveId(source, importer) {
      if (!source.endsWith(FETCHER_QUERY)) return undefined;
      const target = source.slice(0, -FETCHER_QUERY.length);
      const resolved = await this.resolve(target, importer, { skipSelf: true });
      return resolved ? PREFIX + resolved.id : undefined;
    },
    load(id) {
      if (!id.startsWith(PREFIX)) return undefined;
      const file = id.slice(PREFIX.length);
      if (serve) return `export default ${JSON.stringify(`/@fs${file}`)};`;
      const ref = this.emitFile({
        type: "chunk",
        id: file,
        preserveSignature: "strict",
      });
      chunks.add(ref);
      return `export default import.meta.ROLLUP_FILE_URL_${ref};`;
    },
    // Vite renders a file URL as a path under the base, which only a
    // browser can load.
    resolveFileUrl({ referenceId, relativePath }) {
      if (this.environment.config.consumer !== "server") return null;
      if (!chunks.has(referenceId)) return null;
      const path = relativePath.startsWith(".")
        ? relativePath
        : `./${relativePath}`;
      return `new URL(${JSON.stringify(path)}, import.meta.url).href`;
    },
  };
}

/** What an SSR example's server entry exports. */
export interface ServerEntry {
  render(request: RenderRequest): Promise<RenderedPage>;
}

export interface RenderRequest {
  /** Where this server listens, and so where the mock backend answers. */
  origin: string;
}

/** Markup for the placeholders in the example's index.html. */
export interface RenderedPage {
  /** Replaces `<!--ssr-head-->`. */
  head: string;
  /** Replaces `<!--ssr-html-->`, inside the app's root element. */
  html: string;
}

type Render = (url: string, origin: string) => Promise<string>;

function originOf(server: {
  resolvedUrls: { local: string[] } | null;
}): string {
  const url = server.resolvedUrls?.local[0];
  if (url === undefined) throw new Error("the server has no local address");
  return url;
}

function pageMiddleware(origin: () => string, render: Render): Middleware {
  return (req, res, next) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method !== "GET" || (path !== "/" && path !== "/index.html")) {
      return next();
    }
    render(req.url ?? "/", origin())
      .then((html) => {
        res.statusCode = 200;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(new TextEncoder().encode(html));
      })
      .catch(next);
  };
}

async function fill(
  template: string,
  entry: ServerEntry,
  origin: string,
): Promise<string> {
  const { head, html } = await entry.render({ origin });
  return template
    .replace("<!--ssr-head-->", () => head)
    .replace("<!--ssr-html-->", () => html);
}

/**
 * Renders the page at `/` on the server, with the `render` export of
 * `entry` (a path from the project root), on `vite` and on `vite preview`.
 * `vite build --app` builds the browser bundle into dist/client and the
 * server entry into dist/server.
 */
export function ssrPage({ entry }: { entry: string }): Plugin {
  const name = entry.replace(/^.*\//, "").replace(/\.[^.]+$/, "");
  let root = "";
  return {
    name: "tscache-examples:ssr-page",
    config: () => ({
      // No SPA fallback: every page this server has is rendered here.
      appType: "custom",
      builder: {},
      environments: {
        client: { build: { outDir: "dist/client" } },
        ssr: {
          build: { outDir: "dist/server", rolldownOptions: { input: entry } },
        },
      },
    }),
    configResolved(config) {
      root = config.root;
    },
    configureServer(server) {
      const ssr = server.environments.ssr;
      if (ssr === undefined || !isRunnableDevEnvironment(ssr)) {
        throw new Error("ssrPage needs Vite's runnable SSR environment");
      }
      const render: Render = async (url, origin) => {
        const source = await readFile(`${root}/index.html`, "utf8");
        const template = await server.transformIndexHtml(url, source);
        const module = await ssr.runner.import<ServerEntry>(`/${entry}`);
        return fill(template, module, origin);
      };
      server.middlewares.use(pageMiddleware(() => originOf(server), render));
    },
    configurePreviewServer(server) {
      // Vite loads this plugin through a module runner that is closed by
      // the time a request arrives, so import() would fail here; require()
      // of an ES module (Node 22.12 and later) loads it natively.
      const require = createRequire(`${root}/`);
      const render: Render = async (_url, origin) => {
        const template = await readFile(
          `${root}/dist/client/index.html`,
          "utf8",
        );
        const module = require(`./dist/server/${name}.js`) as ServerEntry;
        return fill(template, module, origin);
      };
      server.middlewares.use(pageMiddleware(() => originOf(server), render));
    },
  };
}
