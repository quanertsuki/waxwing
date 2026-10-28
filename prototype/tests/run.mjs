// Single-process test entry. The default `node --test` runner isolates each
// file in a spawned process, which the sandbox forbids (spawn EPERM), so every
// suite is imported here into one process.
//
// Run:  node tests/run.mjs
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {pruneScratchRoots, scratchRoot} from './scratch.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const dataRoot=scratchRoot(HERE);
pruneScratchRoots(HERE,dataRoot);
fs.rmSync(dataRoot,{recursive:true,force:true});
// Isolate the manager under test: never touch the live prototype-data root.
// WAXWING_HOME outranks DSH_SUBAGENT_ROOT in config resolution, so pin it too:
// a caller that already exports WAXWING_HOME must not drag the suite onto a
// live data root (the manager suite refuses to run in that case).
process.env.WAXWING_HOME=dataRoot;
process.env.DSH_SUBAGENT_ROOT=dataRoot;
process.env.DSH_PROTOTYPE_ROOT=dataRoot;
process.env.DSH_SUBAGENT_PROVIDERS_DIR=path.join(HERE,'fixtures','providers');
process.env.DSH_SUBAGENT_LOCAL_CONFIG=path.join(HERE,'fixtures','test-config.json');
process.env.DSH_SUBAGENT_PORT='43199';
process.env.DSH_PROTOTYPE_PORT='43199';

await import('./budget.test.mjs');
await import('./config.test.mjs');
await import('./plugin.test.mjs');
await import('./mcp.test.mjs');
await import('./effort.test.mjs');
await import('./integrations.test.mjs');
await import('./openai-chat.test.mjs');
await import('./manager.test.mjs');
await import('./compact.test.mjs');
await import('./reliability.test.mjs');
await import('./runtime-module.test.mjs');
await import('./runtime-protocol.test.mjs');
await import('./runtime-identity.test.mjs');
await import('./runtime-lifecycle.test.mjs');
await import('./runtime-outcome.test.mjs');
await import('./runtime-close-outcome.test.mjs');
await import('./acceptance-module.test.mjs');
await import('./release-tree.test.mjs');
await import('./task-lifecycle.test.mjs');
await import('./task-repository-restore.test.mjs');
await import('./task-transaction.test.mjs');
await import('./task-command-module.test.mjs');
await import('./task-view.test.mjs');
await import('./workspace.test.mjs');
await import('./workspace-lease-module.test.mjs');
await import('./research.test.mjs');
await import('./research-state.test.mjs');
await import('./research-refresh.test.mjs');
await import('./change-notifier.test.mjs');
await import('./cli.test.mjs');
await import('./usage.test.mjs');
await import('./usage-policy.test.mjs');
await import('./usage-module.test.mjs');
await import('./execution-limits.test.mjs');
