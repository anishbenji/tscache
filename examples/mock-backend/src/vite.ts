// Vite plugins for the examples: one mounts the mock backend on the dev and
// preview servers, so each example runs from a single command, and one
// renders the SSR examples' page on the server. The fetcher's URL comes from
// tscache's own plugin, `fetcherUrl()` in `tscache/vite`.

/// <reference path="./node.d.ts" />

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isRunnableDevEnvironment, type Plugin } from "vite";
import { WebSocketServer } from "ws";
import { type Backend, type BackendOptions, createBackend } from "./backend";

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
  write(chunk: Uint8Array): boolean;
  end(body?: Uint8Array): void;
  /** "close": the response ended, or the client went away. */
  on(event: "close", listener: () => void): unknown;
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

async function toRequest(
  req: NodeRequest,
  signal: AbortSignal,
): Promise<Request> {
  const headers = toHeaders(req.headers);
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers, signal });
  }
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for await (const chunk of req) chunks.push(chunk);
  return new Request(url, { method, headers, body: new Blob(chunks), signal });
}

/** Writes the body as it arrives, so a live stream reaches the browser. */
async function send(res: NodeResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => {
    res.setHeader(name, value);
  });
  if (response.body === null) return void res.end();
  for await (const chunk of response.body) res.write(chunk);
  res.end();
}

/** The path live sockets connect to (Backend.socket). */
const SOCKET_PATH = "/api/live";

/** The parts of Node's HTTP server the socket upgrade uses. */
interface UpgradingServer {
  on(
    event: "upgrade",
    listener: (req: NodeRequest, socket: unknown, head: unknown) => void,
  ): unknown;
}

/**
 * Hands each WebSocket upgrade on /api/live to the backend. Other upgrades
 * (Vite's own HMR socket) are left to their listeners.
 */
function serveSockets(backend: Backend, server: UpgradingServer | null): void {
  const sockets = new WebSocketServer({ noServer: true });
  server?.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== SOCKET_PATH) {
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      const handler = backend.socket({
        send: (text) => ws.send(text),
        close: (code, reason) => ws.close(code, reason),
      });
      ws.on("message", (data) => handler.message(String(data)));
      ws.on("close", () => handler.closed());
      // A socket error closes it; without a listener it would throw.
      ws.on("error", () => handler.closed());
    });
  });
}

/**
 * Serves the mock backend under /api/ on `vite` and `vite preview`: HTTP
 * requests, and live sockets on /api/live.
 */
export function mockBackend(options?: BackendOptions): Plugin {
  const backend = createBackend(options);
  const middleware: Middleware = (req, res, next) => {
    if (!req.url?.startsWith("/api/")) return next();
    // A client that goes away ends the backend's answer (a live stream).
    const gone = new AbortController();
    res.on("close", () => gone.abort());
    toRequest(req, gone.signal)
      .then(backend)
      .then((response) => (response ? send(res, response) : next()))
      .catch(next);
  };
  return {
    name: "tscache-examples:mock-backend",
    configureServer(server) {
      server.middlewares.use(middleware);
      serveSockets(backend, server.httpServer);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
      serveSockets(backend, server.httpServer);
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
  /** The page's URL as requested: its path and query. */
  url: string;
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

function pageMiddleware(
  paths: readonly string[],
  origin: () => string,
  render: Render,
): Middleware {
  return (req, res, next) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method !== "GET" || !paths.includes(path)) return next();
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
  request: RenderRequest,
): Promise<string> {
  const { head, html } = await entry.render(request);
  return template
    .replace("<!--ssr-head-->", () => head)
    .replace("<!--ssr-html-->", () => html);
}

export interface SsrPageOptions {
  /** The server entry, a path from the project root. */
  entry: string;
  /**
   * Where the page is served. Default `/`, which makes this the server's
   * only page; any other path leaves the app's other pages to Vite.
   */
  path?: string;
  /** The page's HTML template, from the project root. Default index.html. */
  template?: string;
}

/**
 * Renders the page at `path` on the server, with the `render` export of
 * `entry`, on `vite` and on `vite preview`. `vite build --app` builds the
 * browser bundle into dist/client and the server entry into dist/server.
 */
export function ssrPage({
  entry,
  path = "/",
  template = "index.html",
}: SsrPageOptions): Plugin {
  const name = entry.replace(/^.*\//, "").replace(/\.[^.]+$/, "");
  const paths = path === "/" ? ["/", "/index.html"] : [path];
  let root = "";
  return {
    name: "tscache-examples:ssr-page",
    config: () => ({
      // No SPA fallback when this is the only page: it is rendered here.
      ...(path === "/" && { appType: "custom" as const }),
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
        const source = await readFile(`${root}/${template}`, "utf8");
        const html = await server.transformIndexHtml(url, source);
        const module = await ssr.runner.import<ServerEntry>(`/${entry}`);
        return fill(html, module, { origin, url });
      };
      server.middlewares.use(
        pageMiddleware(paths, () => originOf(server), render),
      );
    },
    configurePreviewServer(server) {
      // Vite loads this plugin through a module runner that is closed by
      // the time a request arrives, so import() would fail here; require()
      // of an ES module (Node 22.12 and later) loads it natively.
      const require = createRequire(`${root}/`);
      const render: Render = async (url, origin) => {
        const html = await readFile(`${root}/dist/client/${template}`, "utf8");
        const module = require(`./dist/server/${name}.js`) as ServerEntry;
        return fill(html, module, { origin, url });
      };
      server.middlewares.use(
        pageMiddleware(paths, () => originOf(server), render),
      );
    },
  };
}
