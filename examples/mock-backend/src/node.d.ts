// The Node APIs the Vite plugins use, declared here, as the request and
// response shapes in vite.ts are, so the examples need no Node type
// definitions.

declare module "node:fs/promises" {
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
}

declare module "node:module" {
  export function createRequire(path: string): (id: string) => unknown;
}
