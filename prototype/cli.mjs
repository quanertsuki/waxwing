// Compatibility entry point. The CLI implementation lives in
// src/adapters/cli.mjs; this file keeps `node prototype/cli.mjs` and the
// package's exports/bin paths working, and starts the CLI when invoked.
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export * from '../src/adapters/cli.mjs';
import {main} from '../src/adapters/cli.mjs';

const selfUrl = pathToFileURL(path.resolve(process.argv[1] ?? '')).href;
if (import.meta.url === selfUrl) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
