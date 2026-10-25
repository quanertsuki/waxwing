import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {findMachineSpecificPath} from '../../scripts/check-release-tree.mjs';
import {renderMagpiePlugin} from '../../scripts/generate-magpie-plugin.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const PLUGIN = path.join(ROOT, 'integrations', 'waxwing.agent.js');

test('Magpie agent plugin stays inside the loader sandbox', async () => {
  const source = fs.readFileSync(PLUGIN, 'utf8');
  // Magpie hands the plugin only `console`: no import.meta.url, no process.
  const code = source.replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(source, /from\s+["']node:/);
  assert.doesNotMatch(code, /import\.meta/);
  assert.doesNotMatch(code, /\bprocess\./);

  const {agent} = await import(pathToFileURL(PLUGIN).href);
  assert.equal(agent.id, 'waxwing');
  assert.equal(agent.name, 'Waxwing');
  assert.equal(agent.dir, '$WAXWING_REPO');
  assert.equal(agent.config, '$WAXWING_PROVIDERS_DIR/magpie.json');
});

test('Magpie generator resolves local paths without leaking them', async () => {
  const dir = path.join(ROOT, 'fixtures', 'waxwing');
  const config = path.join(ROOT, 'fixtures', 'waxwing-data', 'providers', 'magpie.json');
  const source = renderMagpiePlugin({dir, config});

  assert.doesNotMatch(source, /from\s+["']node:/);
  assert.doesNotMatch(source, /import\.meta/);
  assert.doesNotMatch(source, /\bprocess\./);

  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const {agent} = await import(moduleUrl);
  assert.equal(agent.dir, dir);
  assert.equal(agent.config, config);
});

test('release guard rejects machine paths with both slash styles', () => {
  const windowsHome = ['C:', 'Users', 'example', 'waxwing'].join('\\');
  const windowsHomeForward = windowsHome.replaceAll('\\', '/');
  const legacyRoot = ['I:', 'DS_subagent', 'integrations'].join('\\');
  const legacyRootForward = legacyRoot.replaceAll('\\', '/');

  assert.equal(findMachineSpecificPath(windowsHome), true);
  assert.equal(findMachineSpecificPath(windowsHomeForward), true);
  assert.equal(findMachineSpecificPath(legacyRoot), true);
  assert.equal(findMachineSpecificPath(legacyRootForward), true);
  assert.equal(findMachineSpecificPath('/workspace/waxwing'), false);
});
