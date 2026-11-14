// The demo recorder's gate on its demo's backend (scripts/demo/record.ts).
// The recorded app's port is the recorder's only while its own launcher
// serves it: before `waitForHub` accepts that launcher's hub the port may be
// another demo's (step 65 R3-1), and once the launcher starts stopping it may
// be anyone's again. The recorder calls `lose()` when the launcher prints its
// stopping line (scripts/demo/lines.ts), first thing in its shutdown, and
// again when it exits. Every request to the backend goes through `request`,
// the clock's reset at shutdown included, so none is sent outside that window.
//
// What remains: when the recorded app's server exits on its own, its port is
// free from that moment until the recorder has read the launcher's stopping
// line (the launcher hearing the exit, printing the line, the pipe carrying
// it). A request sent in that interval, or already on its way, can still
// reach whatever binds the port meanwhile.

import { request } from "./request";

export class Backend {
  readonly #origin: string;
  readonly #fetcher: typeof fetch;
  #owned = false;
  /** Set once the demo has exited; the backend is never owned again. */
  #lost = false;

  /** `fetcher` is for tests. */
  constructor(origin: string, fetcher: typeof fetch = fetch) {
    this.#origin = origin;
    this.#fetcher = fetcher;
  }

  /** Whether requests are sent: accepted, and its demo not exited. */
  get owned(): boolean {
    return this.#owned;
  }

  /** The recorder's own launcher's hub is up: its backend is the recorder's. */
  accept(): void {
    if (!this.#lost) this.#owned = true;
  }

  /** The launcher is stopping or gone: its port may be anyone's from now on. */
  lose(): void {
    this.#lost = true;
    this.#owned = false;
  }

  /**
   * Requests `path` on the backend's origin, with the deadline of
   * `request` (BACKEND_MS); rejects without sending unless the backend is
   * the recorder's.
   */
  request(
    path: string,
    init: Omit<RequestInit, "signal"> = {},
  ): Promise<Response> {
    if (!this.#owned) {
      return Promise.reject(
        new Error("the recorder sends requests only to its own demo"),
      );
    }
    return request(`${this.#origin}${path}`, init, this.#fetcher);
  }
}
