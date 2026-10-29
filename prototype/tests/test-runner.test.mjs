// The single-process runner must execute every suite in this directory, and
// the isolation environment must be defined in exactly one place.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {discoverSuites} from './discover.mjs';
import {TEST_PORT} from './isolate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, 'run.mjs');
const ISOLATE = path.join(HERE, 'isolate.mjs');

test('discovery returns every suite file in the directory, sorted', () => {
  const onDisk = fs.readdirSync(HERE, {withFileTypes: true})
    .filter(entry => entry.isFile() && entry.name.endsWith('.test.mjs'))
    .map(entry => entry.name);
  const discovered = discoverSuites(HERE);

  assert.deepEqual(discovered, [...discovered].sort(), 'suites must be imported in a stable order');
  assert.deepEqual(discovered, [...onDisk].sort());
  assert.ok(discovered.length > 0);
});

test('the runner imports suites from discovery instead of a hand-written list', () => {
  const source = fs.readFileSync(RUNNER, 'utf8');
  assert.match(source, /discoverSuites\(/);
  // A literal suite import is exactly the failure mode this change removes.
  assert.doesNotMatch(source, /await import\(['"]\.\/[A-Za-z0-9-]+\.test\.mjs['"]\)/);
  assert.match(source, /Test files: \$\{suites\.length\}/);
});

test('isolation environment is defined once, in isolate.mjs', () => {
  const runner = fs.readFileSync(RUNNER, 'utf8');
  const isolate = fs.readFileSync(ISOLATE, 'utf8');
  for (const name of [
    'WAXWING_HOME',
    'DSH_SUBAGENT_PROVIDERS_DIR',
    'DSH_SUBAGENT_LOCAL_CONFIG',
    'DSH_SUBAGENT_PORT',
    'DSH_PROTOTYPE_PORT',
  ]) {
    assert.match(isolate, new RegExp(`process\\.env\\.${name}\\s*=`), `${name} belongs in isolate.mjs`);
    assert.doesNotMatch(runner, new RegExp(`process\\.env\\.${name}\\s*=`), `${name} must not be set by the runner`);
  }
});

test('importing the isolation module pins the test port', () => {
  assert.equal(TEST_PORT, '43199');
  assert.equal(process.env.DSH_SUBAGENT_PORT, TEST_PORT);
  assert.equal(process.env.DSH_PROTOTYPE_PORT, TEST_PORT);
});
