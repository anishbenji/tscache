// What a reference client's page server needs besides the shared reader
// (@tscache/integrations/shared/server).

/**
 * The credential the page server reads with: the mock backend's service
 * token. A real server takes its own from its environment; it is never a
 * visitor's, since every visitor shares the server's cache.
 */
export const SERVICE_TOKEN = "reference-page-server";
