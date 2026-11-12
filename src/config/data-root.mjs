// Data-root lifecycle: one-time legacy copy and directory creation. Both use
// an explicit context so tests and secondary managers never touch the
// process-wide default.
import fs from 'node:fs';
import path from 'node:path';
import {atomicWriteJson} from '../storage/durable-file.mjs';
import {canonicalPath} from '../paths/path-utils.mjs';
import {runtimeContext} from './context.mjs';

/**
 * Copy legacy task data into the new data root. The source directory is never
 * modified, and a non-empty target is refused rather than merged or replaced.
 * Parameters are injectable so this safety boundary can be tested without
 * starting another manager.
 */
export function migrateLegacyData(options = {}) {
  const context = options.context ?? runtimeContext();
  const targetRoot = path.resolve(options.targetRoot ?? context.root);
  const explicitlyConfigured = options.rootExplicit ?? context.config.rootExplicit;
  if (explicitlyConfigured) return;
  const legacyRoot = options.legacyRoot ?? context.config.legacyRoot;
  if (!legacyRoot) return;
  const resolvedLegacyRoot = path.resolve(legacyRoot);
  if (canonicalPath(resolvedLegacyRoot) === canonicalPath(targetRoot)) return;
  const marker = path.join(targetRoot, '.migration.json');
  if (fs.existsSync(marker)) return;
  const names = ['runs', 'reports', 'providers'].filter(name =>
    fs.existsSync(path.join(resolvedLegacyRoot, name)));
  if (names.length === 0) return;
  if (fs.existsSync(targetRoot)) {
    const existing = fs.readdirSync(targetRoot).filter(name => name !== '.migration.json');
    if (existing.length > 0) {
      throw new Error(`Legacy data migration blocked: new data directory ${targetRoot} is not empty; old data was retained at ${resolvedLegacyRoot}`);
    }
  }
  fs.mkdirSync(targetRoot, {recursive: true});
  const copied = [];
  try {
    for (const name of names) {
      const source = path.join(resolvedLegacyRoot, name);
      const destination = path.join(targetRoot, name);
      fs.cpSync(source, destination, {recursive: true, force: false, errorOnExist: true});
      copied.push(name);
    }
    atomicWriteJson(marker, {
      from: resolvedLegacyRoot,
      copied,
      migratedAt: new Date().toISOString(),
      policy: 'copy-only-legacy-data-retained',
    }, {mode: 0o600});
  } catch (error) {
    throw new Error(`Legacy data migration failed; old data remains at ${resolvedLegacyRoot}: ${error.message}`);
  }
}

/** Create the manager's data directories for one context. */
export function ensureDataDirs(context = runtimeContext()) {
  migrateLegacyData({context});
  for (const directory of [context.runsDir, context.reportsDir, context.runtimeDir]) {
    fs.mkdirSync(directory, {recursive: true});
  }
}
