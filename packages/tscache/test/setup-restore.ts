// CacheState.restore's implementation is engine/restore.ts, which the
// persister installs when it is built, so that only the lazily loaded
// persistence chunk carries it (docs/architecture.md §4.10.5, §4.10.8).
// Unit tests that call restore on a CacheState without building a persister
// get it installed here, before every test file.

import { installRestore } from "../src/engine/cache";
import { restore } from "../src/engine/restore";

installRestore(restore);
