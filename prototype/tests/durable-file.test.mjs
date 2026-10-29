// One durable-write implementation: unique temporary names, retry on the
// transient Windows rename errors, cleanup on failure, and a replace-with-
// backup transaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  atomicWriteJson,
  atomicWriteText,
  beginReplace,
  sha256,
} from '../../src/storage/durable-file.mjs';

function temporaryRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'waxwing-durable-'));
}

function transientError() {
  return Object.assign(new Error('file is locked'), {code: 'EPERM'});
}

/** Real fs with a rename that fails `times` times before delegating. */
function flakyRename(times) {
  let remaining = times;
  return {
    ...fs,
    existsSync: (...args) => fs.existsSync(...args),
    mkdirSync: (...args) => fs.mkdirSync(...args),
    rmSync: (...args) => fs.rmSync(...args),
    writeFileSync: (...args) => fs.writeFileSync(...args),
    readFileSync: (...args) => fs.readFileSync(...args),
    renameSync: (...args) => {
      if (remaining > 0) {
        remaining -= 1;
        throw transientError();
      }
      return fs.renameSync(...args);
    },
  };
}

test('a transient rename error is retried until the write succeeds', () => {
  const root = temporaryRoot();
  try {
    const file = path.join(root, 'state.json');
    atomicWriteText(file, '{"ok":true}', {files: flakyRename(1), pause: () => {}});
    assert.equal(fs.readFileSync(file, 'utf8'), '{"ok":true}');
    assert.deepEqual(fs.readdirSync(root), ['state.json']);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('a permanent rename error throws, removes the temporary file, and keeps the old content', () => {
  const root = temporaryRoot();
  try {
    const file = path.join(root, 'state.json');
    fs.writeFileSync(file, 'old');
    assert.throws(
      () => atomicWriteText(file, 'new', {files: flakyRename(Infinity), attempts: 2, pause: () => {}}),
      /file is locked/,
    );
    assert.equal(fs.readFileSync(file, 'utf8'), 'old');
    assert.deepEqual(fs.readdirSync(root), ['state.json']);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('two writes to one path leave one complete version and no temporary files', async () => {
  const root = temporaryRoot();
  try {
    const file = path.join(root, 'state.json');
    const first = 'a'.repeat(4096);
    const second = 'b'.repeat(4096);
    await Promise.all([
      Promise.resolve().then(() => atomicWriteText(file, first)),
      Promise.resolve().then(() => atomicWriteText(file, second)),
    ]);
    const written = fs.readFileSync(file, 'utf8');
    assert.ok(written === first || written === second, 'a reader never sees a mix of both writes');
    assert.deepEqual(fs.readdirSync(root), ['state.json']);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('a replace commit removes the backup and a rollback restores the old bytes', () => {
  const root = temporaryRoot();
  try {
    const file = path.join(root, 'report.md');
    fs.writeFileSync(file, 'old report');

    const committed = beginReplace(file, 'new report');
    assert.equal(fs.readFileSync(file, 'utf8'), 'new report');
    assert.equal(committed.hash, sha256('new report'));
    committed.commit();
    assert.equal(fs.readFileSync(file, 'utf8'), 'new report');
    assert.deepEqual(fs.readdirSync(root), ['report.md']);

    const rolledBack = beginReplace(file, 'broken attempt');
    rolledBack.rollback();
    assert.equal(fs.readFileSync(file, 'utf8'), 'new report');
    assert.deepEqual(fs.readdirSync(root), ['report.md']);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('rolling back a first write removes the file it created', () => {
  const root = temporaryRoot();
  try {
    const file = path.join(root, 'fresh.md');
    const opened = beginReplace(file, 'content');
    opened.rollback();
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('atomicWriteJson keeps the pretty-printed JSON format', () => {
  const root = temporaryRoot();
  try {
    const file = path.join(root, 'config.json');
    atomicWriteJson(file, {a: 1, b: [2]});
    assert.equal(fs.readFileSync(file, 'utf8'), '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}');
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});
