// Which live feed the page takes: Server-Sent Events, a WebSocket, or
// polling (live.ts). All tabs of an origin take the same one, whichever
// tab holds it, so the choice is stored for every tab: the latest choice,
// from the menu or a `?feed=` in a page's URL, is every tab's.

export type FeedKind = "sse" | "ws" | "poll";

const KEY = "tscache-reference:feed";

/** The feeds in the order a menu lists them, with their names. */
export const FEED_OPTIONS: readonly (readonly [FeedKind, string])[] = [
  ["sse", "Server-Sent Events"],
  ["ws", "WebSocket"],
  ["poll", "Polling"],
];

/** The feed a page takes when nothing chose another. */
export const DEFAULT_FEED: FeedKind = "sse";

function kindOf(value: string | null): FeedKind | undefined {
  return FEED_OPTIONS.find(([kind]) => kind === value)?.[0];
}

/** The feed a URL's query asks for (`?feed=ws`), if any. */
export function feedKindOf(search: string): FeedKind | undefined {
  return kindOf(new URLSearchParams(search).get("feed"));
}

/** The feed chosen last, in any tab. */
export function storedFeed(): FeedKind | undefined {
  return kindOf(localStorage.getItem(KEY));
}

/** Makes `kind` every tab's feed. */
export function storeFeed(kind: FeedKind): void {
  localStorage.setItem(KEY, kind);
}

/**
 * Calls `listener` when another tab chooses a feed. Returns the
 * unsubscribe.
 */
export function onFeedStored(listener: (kind: FeedKind) => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== KEY) return;
    // What is stored now, not the event's value: an event can arrive after
    // a later choice, and adopting its value would undo that choice here.
    const kind = storedFeed();
    if (kind !== undefined) listener(kind);
  };
  addEventListener("storage", onStorage);
  return () => removeEventListener("storage", onStorage);
}

/**
 * Keeps a `?feed=` in the page's URL to the feed every tab takes now, so a
 * reload does not make an older choice every tab's again. A URL without
 * one is left so: its page takes the stored choice.
 */
export function showFeedInUrl(kind: FeedKind): void {
  const url = new URL(location.href);
  const asked = url.searchParams.get("feed");
  if (asked === null || asked === kind) return;
  url.searchParams.set("feed", kind);
  history.replaceState(history.state, "", url);
}
