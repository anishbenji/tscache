// The page's log: what the client, the cache and the backend did, newest
// first. A module-level store, so code outside components can write to it.
// Only the browser writes; the server renders it empty.

import { useSyncExternalStore } from "react";

export interface LogEntry {
  id: number;
  text: string;
}

const LIMIT = 50;
const NONE: readonly LogEntry[] = [];
let entries = NONE;
let nextId = 0;
const listeners = new Set<() => void>();

export function log(line: string): void {
  const time = new Date().toLocaleTimeString();
  const entry = { id: nextId++, text: `${time}  ${line}` };
  entries = [entry, ...entries].slice(0, LIMIT);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The entries; empty on the server and in the browser's hydration render. */
export function useLog(): readonly LogEntry[] {
  return useSyncExternalStore(
    subscribe,
    () => entries,
    () => NONE,
  );
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
