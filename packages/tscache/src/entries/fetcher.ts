// './fetcher' entry — fetcher-author surface (architecture.md §8 N6). Its
// module graph must stay free of DOM/client code: it re-exports only from
// errors.ts, which is import-free; the fetcher types are type-only imports.

/**
 * What a fetcher module needs: its types and `AuthInvalidError`, with no
 * other imports, so a fetcher bundle stays small.
 *
 * @module tscache/fetcher
 */
export { AUTH_INVALID_CODE, AuthInvalidError } from "../errors";
export type { Fetcher, FetchRequest, FetchResponse, Range } from "../types";
