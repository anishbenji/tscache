// Vite plugins for the examples: one mounts the mock backend on the dev and
// preview servers, so each example runs from a single command; the other
// gives the URL of a fetcher module, which tscache's worker import()s.

import type { Plugin } from "vite";
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
 */
export function fetcherUrl(): Plugin {
  let serve = false;
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
      return `export default import.meta.ROLLUP_FILE_URL_${ref};`;
    },
  };
}
