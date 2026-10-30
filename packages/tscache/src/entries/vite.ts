// './vite' entry — Vite plugins for apps that use tscache (N40–N41). Vite
// is an optional peer dependency; this entry imports nothing from it.

/**
 * The Vite plugin that serves a fetcher module with its exports intact.
 *
 * @module tscache/vite
 */

export type { FetcherUrlPlugin } from "../vite/fetcher-url";
export { fetcherUrl } from "../vite/fetcher-url";
