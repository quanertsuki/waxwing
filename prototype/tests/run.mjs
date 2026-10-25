// Single-process test entry. The default `node --test` runner isolates each
// file in a spawned process, which the sandbox forbids (spawn EPERM), so every
// suite is imported here into one process.
//
// Run:  node tests/run.mjs
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const dataRoot=path.join(HERE,'.tmp',`data-${process.pid}`);
fs.rmSync(dataRoot,{recursive:true,force:true});
// Isolate the manager under test: never touch the live prototype-data root.
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
await import('./runtime-protocol.test.mjs');
await import('./runtime-identity.test.mjs');
await import('./workspace.test.mjs');
await import('./cli.test.mjs');
await import('./usage.test.mjs');
await import('./execution-limits.test.mjs');
