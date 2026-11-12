// Test suite discovery for the single-process runner.
//
// The runner imports every `*.test.mjs` in this directory. Keeping the list out
// of `run.mjs` means a new suite runs without touching the runner, and a suite
// can never be silently left out of `npm test`.
import fs from 'node:fs';
import path from 'node:path';

/** Every file matching this name pattern is a test suite. */
export const SUITE_SUFFIX = '.test.mjs';

/** Sorted suite file names (not paths) in `testsDir`. */
export function discoverSuites(testsDir) {
  return fs.readdirSync(testsDir, {withFileTypes: true})
    .filter(entry => entry.isFile() && entry.name.endsWith(SUITE_SUFFIX))
    .map(entry => entry.name)
    .sort();
}

/** Absolute path for one discovered suite name. */
export function suitePath(testsDir, name) {
  return path.join(testsDir, name);
}
