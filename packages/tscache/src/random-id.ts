/**
 * A random identifier for a worker or a `clearAll` on the workers' channel
 * (docs/architecture.md §4.7, §4.10.7). `crypto.getRandomValues` and not
 * `crypto.randomUUID`: a SharedWorker also runs in a context that is not
 * secure, where the latter does not exist.
 */
export function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let id = "";
  for (const byte of bytes) id += byte.toString(16).padStart(2, "0");
  return id;
}
