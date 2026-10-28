// The Node APIs the Vite plugins use, and the parts of `ws` they use,
// declared here, as the request and response shapes in vite.ts are, so the
// examples need no Node type definitions (`@types/ws` would bring them).

declare module "node:fs/promises" {
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
}

declare module "node:module" {
  export function createRequire(path: string): (id: string) => unknown;
}

declare module "ws" {
  export interface WebSocket {
    send(text: string): void;
    close(code: number, reason: string): void;
    /** `data` is a Buffer; String() decodes it as UTF-8. */
    on(event: "message", listener: (data: unknown) => void): this;
    on(event: "close" | "error", listener: () => void): this;
  }

  export class WebSocketServer {
    constructor(options: { noServer: true });
    handleUpgrade(
      request: unknown,
      socket: unknown,
      head: unknown,
      callback: (socket: WebSocket) => void,
    ): void;
  }
}
