/**
 * Every URL the fetcher plugin builds (step 16 R1-2, R1-3, R2-1, R3-2):
 * each is encoded as the inverse of what decodes it, which differs.
 */

/**
 * The dev server's URL of a file: Vite serves any allowed file at
 * `<base>@fs/<path>`, and its module middleware decodes the request with
 * `decodeURI`, whose inverse is `encodeURI`: a space or a literal `%` is
 * encoded, a Windows drive's `:` is not. A path holding `#` or `?` cannot
 * be served that way at all. A Windows path (`C:/…`) has no leading slash
 * of its own. Vite's own `?url` import is not used: it decodes a literal
 * `%41` in a path to `A`.
 */
export function devUrl(base: string, file: string): string {
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return `${prefix}@fs/${encodeURI(file.replace(/^\/+/, ""))}`;
}

/** Rolldown's hash placeholder, substituted after this hook runs. */
const PLACEHOLDER = /(!~\{\w+\}~)/;

/** A path segment encoded in full, hash placeholders kept for Rolldown. */
function encodeSegment(segment: string): string {
  if (segment === "." || segment === "..") return segment;
  return segment
    .split(PLACEHOLDER)
    .map((part) => (PLACEHOLDER.test(part) ? part : encodeURIComponent(part)))
    .join("");
}

/**
 * Code for the file URL of an emitted chunk, relative to the module that
 * imports it, for server code: `new URL(<path>, import.meta.url).href`.
 * The URL parser and Node's file-URL loading decode every escape, so each
 * path segment is encoded in full (`%`, space, `#`, `?`); the separators
 * stay, and so do Rolldown's hash placeholders (`!~{…}~`), which it
 * replaces with URL-safe hash characters afterwards.
 */
export function serverFileUrl(relativePath: string): string {
  const path = relativePath.split("/").map(encodeSegment).join("/");
  const relative = path.startsWith(".") ? path : `./${path}`;
  return `new URL(${JSON.stringify(relative)}, import.meta.url).href`;
}
