// Single-process test entry. The default `node --test` runner isolates each
// file in a spawned process, which the sandbox forbids (spawn EPERM), so every
// suite is imported here into one process.
//
// Run:  node tests/run.mjs
//
// Isolation lives in isolate.mjs: importing it pins the scratch data root,
// Provider/config fixtures, and ports before any suite loads. The runner only
// forces its own scratch root, because an inherited root from the caller must
// never move the suite onto live data.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {discoverSuites} from './discover.mjs';
import {pruneScratchRoots, scratchRoot} from './scratch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const root = scratchRoot(HERE);
pruneScratchRoots(HERE, root);
fs.rmSync(root, {recursive: true, force: true});
process.env.DSH_SUBAGENT_ROOT = root;
process.env.DSH_PROTOTYPE_ROOT = root;

await import('./isolate.mjs');
const suites = discoverSuites(HERE);

console.log(`Test files: ${suites.length}`);
for (const name of suites) {
  await import(new URL(`./${name}`, import.meta.url));
}
