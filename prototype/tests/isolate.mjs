// Shared test isolation. Import this BEFORE any module that reads common.mjs
// (static imports evaluate in source order), so a direct `node --test` run of
// one suite can never touch the live prototype-data root.
//
// - Missing DSH_SUBAGENT_ROOT: allocate a dedicated scratch root under
//   tests/.tmp, so the suite is self-contained on any drive.
// - A root equal to the configured live data root: refuse loudly.
// - Any other explicit root (used by tests/run.mjs): keep it, only ensure it.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadConfiguration} from '../config.mjs';
import {pruneScratchRoots, scratchRoot} from './scratch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTOTYPE = path.resolve(HERE, '..');
/** Deterministic provider configs; tests must never read the live provider directory. */
export const TEST_PROVIDERS = path.join(HERE, 'fixtures', 'providers');
/** Test-only config overlay; never inherit the developer's local provider routing. */
export const TEST_LOCAL_CONFIG = path.join(HERE, 'fixtures', 'test-config.json');
/** The live manager data root from config.json; tests must never write here. */
export const REAL_ROOT = path.resolve(loadConfiguration({here: PROTOTYPE, env: {}}).config.root);

function samePath(a, b) {
  const left = path.resolve(a), right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

const configured = process.env.DSH_SUBAGENT_ROOT ?? process.env.DSH_PROTOTYPE_ROOT;
const auto = configured === undefined || configured.trim() === '';
const root = path.resolve(auto ? scratchRoot(HERE) : configured);
if (samePath(root, REAL_ROOT)) {
  throw new Error(`test isolation refused: data root points at the live data directory (${root}); tests must use an isolated directory`);
}
if (auto) {
  pruneScratchRoots(HERE, root);
  fs.rmSync(root, {recursive: true, force: true});
}
fs.mkdirSync(root, {recursive: true});
// WAXWING_HOME wins over DSH_SUBAGENT_ROOT during config resolution, so it is
// pinned as well: an inherited WAXWING_HOME from a live runtime must never move
// a test suite back onto real data.
process.env.WAXWING_HOME = root;
process.env.DSH_SUBAGENT_ROOT = root;
process.env.DSH_PROTOTYPE_ROOT = root;
process.env.DSH_SUBAGENT_PROVIDERS_DIR = TEST_PROVIDERS;
process.env.DSH_SUBAGENT_LOCAL_CONFIG = TEST_LOCAL_CONFIG;
/** The isolated data root every suite in this process must use. */
export const TEST_ROOT = root;
