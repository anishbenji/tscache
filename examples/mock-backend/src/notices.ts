// The fetcher runs inside tscache's worker, out of the pages' reach. It
// reports each fetch on a BroadcastChannel so every open tab can show how
// many requests the backend actually received.

import type { Range } from "tscache";

export interface FetchNotice {
  cacheId: string;
  range: Range;
  /** Backend pages the fetch took. */
  pages: number;
  outcome: "ok" | "auth-invalid" | "failed";
}

/** The BroadcastChannel the notices travel on. */
export const NOTICE_CHANNEL = "tscache-examples:fetches";

export function postFetchNotice(notice: FetchNotice): void {
  const channel = new BroadcastChannel(NOTICE_CHANNEL);
  channel.postMessage(notice);
  channel.close();
}

/** Calls `fn` for every fetch any tab's worker makes; returns the unsubscribe. */
export function onFetchNotice(fn: (notice: FetchNotice) => void): () => void {
  const channel = new BroadcastChannel(NOTICE_CHANNEL);
  channel.onmessage = (event: MessageEvent<FetchNotice>) => fn(event.data);
  return () => channel.close();
}
