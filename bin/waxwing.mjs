#!/usr/bin/env node
import {main} from '../src/adapters/cli.mjs';

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
