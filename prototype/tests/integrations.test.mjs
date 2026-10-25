import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const PLUGIN = path.join(ROOT, 'integrations', 'waxwing.agent.js');

test('Magpie agent plugin has no Node imports and expands its config path', async () => {
  const source = fs.readFileSync(PLUGIN, 'utf8');
  assert.doesNotMatch(source, /from\s+["']node:/);

  const {agent} = await import(pathToFileURL(PLUGIN).href);
  assert.equal(agent.id, 'waxwing');
  assert.equal(agent.name, 'Waxwing');
  assert.match(agent.config, /\$(?:LOCALAPPDATA|HOME)\//);
  assert.doesNotMatch(agent.config, /^[A-Za-z]:[\\/]/);
});
