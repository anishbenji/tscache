/**
 * The persistence code loaded lazily (docs/architecture.md §4.10.8): the
 * persister, with `restore` and the record builder, the IndexedDB adapter,
 * and the clear-only call of the hostings that do not persist (§4.10.7,
 * N66). `entries/worker.ts` and `client/in-process.ts` import this module
 * with `import()`, so the build emits it as a chunk of its own, loaded at
 * the first persisted cache in the SharedWorker (`persist/hosted.ts`), or
 * at the first `clearAll` in any hosting (`persist/clear-only.ts`).
 */

export { clearDisk } from "./clear-disk";
export { openIdbStore } from "./idb-store";
export { durably, Persister } from "./persister";
