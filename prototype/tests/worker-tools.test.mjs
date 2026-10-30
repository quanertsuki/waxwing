// Worker-side tool set: the Worker executes these in its own process with the
// task workspace as cwd, and every failure is returned as tool content.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildMinimalTools, executeTool, resolveToolPath} from '../../src/worker/tools.mjs';

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'waxwing-tools-'));
}

test('the minimal tool set exposes bash, read_file, and write_file', () => {
  const tools = buildMinimalTools();
  assert.deepEqual(tools.map(tool => tool.name), ['bash', 'read_file', 'write_file']);
  for (const tool of tools) {
    assert.equal(tool.input_schema.type, 'object');
    assert.ok(Array.isArray(tool.input_schema.required) && tool.input_schema.required.length > 0);
  }
});

test('file tools read and write relative to the workspace', async () => {
  const dir = workspace();
  const written = await executeTool('write_file', {path: 'nested/note.txt', content: 'hello'}, dir);
  assert.match(written.content, /Written 5 bytes/);
  assert.equal(fs.readFileSync(path.join(dir, 'nested', 'note.txt'), 'utf8'), 'hello');

  const read = await executeTool('read_file', {path: 'nested/note.txt'}, dir);
  assert.equal(read.content, 'hello');
});

test('a relative path cannot leave the workspace', async () => {
  const dir = workspace();
  assert.throws(() => resolveToolPath('../outside.txt', dir), /inside the workspace/);
  const result = await executeTool('read_file', {path: '../outside.txt'}, dir);
  assert.match(result.content, /^Error executing read_file: path must stay inside the workspace/);
});

test('bash runs in the workspace and reports its own failures as content', async () => {
  const dir = workspace();
  const result = await executeTool('bash', {command: 'node -e "console.log(process.cwd())"'}, dir);
  const actual = result.content.trim();
  const expected = fs.realpathSync(dir);
  assert.equal(process.platform === 'win32' ? actual.toLowerCase() : actual,
    process.platform === 'win32' ? expected.toLowerCase() : expected);

  const unknown = await executeTool('nope', {}, dir);
  assert.match(unknown.content, /unknown tool/);
  const missing = await executeTool('bash', {}, dir);
  assert.match(missing.content, /command is required/);
});

test('write_file stays inside the workspace while read_file may look outside', async () => {
  const dir = workspace();
  const outside = workspace();
  const source = path.join(outside, 'source.txt');
  fs.writeFileSync(source, 'from the source project');

  const read = await executeTool('read_file', {path: source}, dir);
  assert.equal(read.content, 'from the source project');

  const refused = await executeTool('write_file', {path: path.join(outside, 'leak.txt'), content: 'x'}, dir);
  assert.match(refused.content, /^Error executing write_file: path must stay inside the workspace/);
  assert.equal(fs.existsSync(path.join(outside, 'leak.txt')), false);

  // A sibling whose name merely starts with the workspace path is still outside.
  const sibling = `${dir}-sibling`;
  assert.throws(() => resolveToolPath(path.join(sibling, 'x.txt'), dir), /inside the workspace/);

  const inside = await executeTool('write_file', {path: path.join(dir, 'in.txt'), content: 'ok'}, dir);
  assert.match(inside.content, /Written 2 bytes/);
  assert.equal(fs.readFileSync(path.join(dir, 'in.txt'), 'utf8'), 'ok');
});
