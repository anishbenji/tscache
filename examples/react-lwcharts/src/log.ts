// The page's log: what the backend, the cache and the token recovery did,
// newest first. A module-level store, so code outside components (event
// handlers, the refresh snippet's callbacks) can write to it.

import { useSyncExternalStore } from "react";

export interface LogEntry {
  id: number;
  text: string;
}

const LIMIT = 50;
let entries: readonly LogEntry[] = [];
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

export function useLog(): readonly LogEntry[] {
  return useSyncExternalStore(subscribe, () => entries);
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
