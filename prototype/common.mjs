// Compatibility facade for the 0.1 backend layout. Path utilities, the
// runtime context, data-root lifecycle, and the loopback client now live under
// src/; this module keeps the old import paths working for callers and tests.
//
// Nothing here reads configuration at import time: `runtimeContext()` does it
// on first use, and the manager receives its context from the assembly point.
import {atomicWriteJson} from '../src/storage/durable-file.mjs';

export {
  canonicalPath,
  canonicalExistingPath,
  isDriveRoot,
  pathsOverlap,
  sameOrDescendantPath,
} from '../src/paths/path-utils.mjs';
export {
  PROTOTYPE_DIR as HERE,
  PROTOTYPE_DIR,
  createRuntimeContext,
  getConfig,
  runtimeContext,
} from '../src/config/context.mjs';
export {ensureDataDirs, migrateLegacyData} from '../src/config/data-root.mjs';
export {cleanEnvironment, readToken, request} from '../src/adapters/client.mjs';

/** Atomic JSON write with the owner-only mode the manager's data uses. */
export function atomicJson(file, data) {
  return atomicWriteJson(file, data, {mode: 0o600});
}

/** Create the default context's data directories. */
export {ensureDataDirs as ensureDirs} from '../src/config/data-root.mjs';
