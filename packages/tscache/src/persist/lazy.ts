/**
 * The persistence code the SharedWorker loads lazily (docs/architecture.md
 * §4.10.8): the persister, with `restore` and the record builder, and the
 * IndexedDB adapter. `entries/worker.ts` imports this module with
 * `import()`, so the build emits it as a chunk of its own, loaded at the
 * first persisted cache or the first `clearAll` (`persist/hosted.ts`).
 */

export { openIdbStore } from "./idb-store";
export { durably, Persister } from "./persister";
