// The demo recorder's one way to make an HTTP request (scripts/demo/record.ts):
// to its demo's backend, the server-rendered page and the hub. Each request,
// its body included, fails with a TimeoutError after BACKEND_MS, so no exit
// path hangs on a server that never answers. The deadline is an
// AbortController and a setTimeout rather than AbortSignal.timeout, so that
// Vitest's fake timers drive it (scripts/demo/request.test.ts).

/** How long any HTTP request of the recorder may take, its body included. */
export const BACKEND_MS = 5000;

/**
 * Fetches `url` and reads the whole body within BACKEND_MS; rejects with a
 * `TimeoutError` once they pass. The response returned holds the body read,
 * so reading it again cannot wait on the server. `fetcher` is for tests.
 */
export async function request(
  url: string,
  init: Omit<RequestInit, "signal"> = {},
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(
        new DOMException(
          `no answer from ${url} within ${BACKEND_MS} ms`,
          "TimeoutError",
        ),
      ),
    BACKEND_MS,
  );
  try {
    const response = await fetcher(url, {
      ...init,
      signal: controller.signal,
    });
    const body = await response.arrayBuffer();
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    // Whatever the fetch rejected with once aborted, the cause is the deadline.
    throw controller.signal.aborted ? controller.signal.reason : error;
  } finally {
    clearTimeout(timer);
  }
}
