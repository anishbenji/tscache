// './fetcher' entry — fetcher-author surface (architecture.md §8 N6). Its
// module graph must stay free of DOM/client code: it re-exports only from
// errors.ts, which is import-free. FetchRequest/FetchResponse types land at
// step ⑪.
export { AUTH_INVALID_CODE, AuthInvalidError } from "../errors";
