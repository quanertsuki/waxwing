import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  checkReleaseTree,
  findMachineSpecificPath,
  required,
  walk,
} from '../../scripts/check-release-tree.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '../../src/app.mjs');

test('the release tree requires every path exported by the public composition root', () => {
  const source = fs.readFileSync(APP, 'utf8');
  const specifiers = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(match => match[1]);
  assert.ok(specifiers.length > 0, 'src/app.mjs must export at least one module');

  for (const specifier of specifiers) {
    assert.ok(specifier.startsWith('.'), `public export must be local: ${specifier}`);
    const entry = path.posix.normalize(
      path.posix.join('src', specifier),
    );
    assert.ok(required.includes(entry), `release tree omits public export: ${entry}`);
  }
  assert.ok(required.includes('src/tasks/lifecycle.mjs'));
});

test('the release check reports a missing public lifecycle module', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waxwing-release-tree-'));
  try {
    for (const file of required) {
      if (file === 'src/tasks/lifecycle.mjs') continue;
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), {recursive: true});
      fs.writeFileSync(target, '');
    }
    const result = checkReleaseTree({root, releaseFiles: walk(root)});
    assert.ok(result.errors.includes('missing required release file: src/tasks/lifecycle.mjs'));
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('the release check scans files for machine-specific paths', () => {
  const legacy = ['I:', 'DS_subagent'].join('\\');
  const legacyNested = ['H:', 'CodeXProj', 'DS_subagent'].join('\\');
  const users = ['C:', 'Users', 'example', 'project'].join('\\');
  const portable = ['C:', 'work', 'my-project'].join('\\');
  const portableOtherDrive = ['D:', 'projects', 'example'].join('\\');
  assert.equal(findMachineSpecificPath(`workspace: ${legacy}`), true);
  assert.equal(findMachineSpecificPath(`workspace: ${legacyNested}`), true);
  assert.equal(findMachineSpecificPath(`workspace: ${users}`), true);
  const posixHome = ['', 'home', 'example', 'project'].join('/');
  assert.equal(findMachineSpecificPath(`workspace: ${posixHome}`), true);
  assert.equal(findMachineSpecificPath(`workspace: ${portable}`), false);
  assert.equal(findMachineSpecificPath(`workspace: ${portableOtherDrive}`), false);
});
