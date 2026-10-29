// The desktop backend copies exactly the `prototype/` files the npm package
// publishes. These tests hold the manifest, the disk, and the copy list
// together so a new module cannot be published but left out of the backend.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {prototypeResourceFiles} from '../../scripts/prepare-desktop-resources.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

test('the repository manifest expands to the current prototype files', () => {
  const {files, errors} = prototypeResourceFiles({root: ROOT});
  assert.deepEqual(errors, []);
  for (const name of ['manager.mjs', 'worker.mjs', 'config.mjs', 'server.mjs', 'mcp.mjs', 'cli.mjs']) {
    assert.ok(files.includes(name), `backend must contain prototype/${name}`);
  }
  for (const name of ['config.json', 'config.example.json', 'config.local.example.json', 'pricing.json', 'execution-policy.md']) {
    assert.ok(files.includes(name), `backend must contain prototype/${name}`);
  }
  assert.ok(!files.includes('Cancel-Smoke.mjs'), 'excluded files stay excluded');
});

test('every literal prototype entry in package.json exists on disk', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const literal = manifest.files
    .filter(entry => entry.startsWith('prototype/') && !entry.startsWith('!'))
    .filter(entry => !entry.includes('*') && !entry.endsWith('/'))
    .map(entry => entry.slice('prototype/'.length));
  for (const name of literal) {
    assert.ok(fs.existsSync(path.join(ROOT, 'prototype', name)), `missing packaged file: prototype/${name}`);
  }
});

test('a deleted packaged file is reported instead of silently dropped', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waxwing-resources-'));
  try {
    fs.mkdirSync(path.join(root, 'prototype'));
    fs.writeFileSync(path.join(root, 'prototype', 'a.mjs'), '');
    fs.writeFileSync(path.join(root, 'prototype', 'skip.mjs'), '');
    const packageJson = {
      files: ['prototype/*.mjs', '!prototype/skip.mjs', 'prototype/config.json'],
    };

    const missing = prototypeResourceFiles({root, packageJson});
    assert.deepEqual(missing.files, ['a.mjs']);
    assert.deepEqual(missing.errors, ['missing packaged prototype file: prototype/config.json']);

    fs.writeFileSync(path.join(root, 'prototype', 'config.json'), '{}');
    const complete = prototypeResourceFiles({root, packageJson});
    assert.deepEqual(complete.files, ['a.mjs', 'config.json']);
    assert.deepEqual(complete.errors, []);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});
