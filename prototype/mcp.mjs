// Compatibility entry point. The MCP stdio adapter lives in
// src/adapters/mcp.mjs; this file keeps `node prototype/mcp.mjs` and the
// package's `./mcp` export working.
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export * from '../src/adapters/mcp.mjs';
import {runStdio} from '../src/adapters/mcp.mjs';

const selfUrl = pathToFileURL(path.resolve(process.argv[1] ?? '')).href;
if (import.meta.url === selfUrl) runStdio();
