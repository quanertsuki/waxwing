// ID 安全整数回归：不安全整数必须明确失败，且数据字节保持原样
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  runCli,
  runJson,
  makeTmpDir,
  cleanupTmpDir,
  readBytes,
  writeUtf8,
} from './helpers.mjs';

const MAX_ID = Number.MAX_SAFE_INTEGER; // 9007199254740991
const OVER_MAX = '9007199254740992';    // 2^53
const WAY_OVER = '9'.repeat(17);        // 远大于安全整数

let dir;
let data;

test.before(() => {
  dir = makeTmpDir('pattern');
  data = path.join(dir, 'tasks.json');
});

test.after(() => {
  cleanupTmpDir(dir);
});

function writeCase(name, text) {
  const file = path.join(dir, name);
  writeUtf8(file, text);
  return file;
}

function taskJson(id, extra = '') {
  return `{"id":${id},"title":"任务","priority":"normal","done":false,"createdAt":"2026-01-01T00:00:00.000Z","completedAt":null${extra}}`;
}

test('加载 nextId=2^53 必须失败且文件字节不变', () => {
  const file = writeCase('nextId-2p53.json', `{"version":1,"nextId":${OVER_MAX},"tasks":[]}`);
  const before = readBytes(file);
  const res = runJson(['--data', file, 'add', '不应写入']);
  assert.equal(res.status, 1, `实际退出码 ${res.status}：${res.stderr}`);
  assert.equal(res.stdout, '');
  assert.equal(res.json, null);
  const parsed = JSON.parse(res.stderr);
  assert.equal(parsed.ok, false);
  assert.match(parsed.message, /nextId/);
  assert.match(parsed.message, /安全正整数/);
  assert.deepEqual(readBytes(file), before, '不安全整数文件必须保持原样');
});

test('加载 nextId 远大于安全整数必须失败且文件字节不变', () => {
  const file = writeCase('nextId-huge.json', `{"version":1,"nextId":${WAY_OVER},"tasks":[]}`);
  const before = readBytes(file);
  const res = runJson(['--data', file, 'add', '不应写入']);
  assert.equal(res.status, 1);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /nextId/);
  assert.deepEqual(readBytes(file), before);
});

test('加载 nextId=2^53+... 的浮点表示（1e300）必须失败', () => {
  const file = writeCase('nextId-float.json', '{"version":1,"nextId":1e300,"tasks":[]}');
  const before = readBytes(file);
  const res = runJson(['--data', file, 'list']);
  assert.equal(res.status, 1, `实际退出码 ${res.status}：${res.stderr}`);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /安全正整数/);
  assert.deepEqual(readBytes(file), before, 'list 失败时同样不得改写文件');
});

test('加载 nextId 为小数/字符串/负数/0 均失败', () => {
  const cases = {
    'nextId-frac.json': '{"version":1,"nextId":1.5,"tasks":[]}',
    'nextId-str.json': '{"version":1,"nextId":"2","tasks":[]}',
    'nextId-neg.json': '{"version":1,"nextId":-1,"tasks":[]}',
    'nextId-zero.json': '{"version":1,"nextId":0,"tasks":[]}',
    'nextId-null.json': '{"version":1,"nextId":null,"tasks":[]}',
  };
  for (const [name, text] of Object.entries(cases)) {
    const file = writeCase(name, text);
    const before = readBytes(file);
    const res = runJson(['--data', file, 'add', '不应写入']);
    assert.equal(res.status, 1, `${name} 实际退出码 ${res.status}：${res.stderr}`);
    assert.equal(res.stdout, '', name);
    assert.match(res.stderr, /nextId/, name);
    assert.deepEqual(readBytes(file), before, `${name} 必须保持原样`);
  }
});

test('加载 task.id=2^53 必须失败且文件字节不变', () => {
  const file = writeCase('taskid-2p53.json', `{"version":1,"nextId":${OVER_MAX},"tasks":[${taskJson(OVER_MAX)}]}`);
  const before = readBytes(file);
  const res = runJson(['--data', file, 'add', '不应写入']);
  assert.equal(res.status, 1, `实际退出码 ${res.status}：${res.stderr}`);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /id/);
  assert.match(res.stderr, /安全正整数/);
  assert.deepEqual(readBytes(file), before);
});

test('加载 task.id 为小数/字符串/负数均失败且文件不变', () => {
  const cases = {
    'taskid-frac.json': `{"version":1,"nextId":3,"tasks":[${taskJson('1.5')}]}`,
    'taskid-str.json': `{"version":1,"nextId":3,"tasks":[${taskJson('"1"')}]}`,
    'taskid-neg.json': `{"version":1,"nextId":3,"tasks":[${taskJson(-1)}]}`,
    'taskid-zero.json': `{"version":1,"nextId":3,"tasks":[${taskJson(0)}]}`,
  };
  for (const [name, text] of Object.entries(cases)) {
    const file = writeCase(name, text);
    const before = readBytes(file);
    const res = runJson(['--data', file, 'add', '不应写入']);
    assert.equal(res.status, 1, `${name} 实际退出码 ${res.status}：${res.stderr}`);
    assert.equal(res.stdout, '', name);
    assert.match(res.stderr, /安全正整数/, name);
    assert.deepEqual(readBytes(file), before, `${name} 必须保持原样`);
  }
});

test('nextId=MAX_SAFE_INTEGER：文件合法可读，但无法再安全分配下一个 ID 时明确失败', () => {
  const file = writeCase('nextId-max.json', `{"version":1,"nextId":${MAX_ID},"tasks":[]}`);
  const before = readBytes(file);

  // list 只读，必须成功
  const listed = runJson(['--data', file, 'list']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(listed.json.tasks, []);

  // add 需要分配 MAX_SAFE_INTEGER 并保存 MAX_SAFE_INTEGER+1，后者不可安全表示 → 明确失败
  const add = runJson(['--data', file, 'add', '超出上界']);
  assert.equal(add.status, 1, `实际退出码 ${add.status}：${add.stderr}`);
  assert.equal(add.stdout, '', '失败时 stdout 必须为空');
  assert.equal(add.json, null);
  let parsed = null;
  try { parsed = JSON.parse(add.stderr); } catch { parsed = null; }
  assert.ok(parsed, `stderr 必须是 JSON：${add.stderr}`);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'ID_EXHAUSTED');
  assert.match(parsed.message, /无法安全分配/);
  assert.deepEqual(readBytes(file), before, '拒绝分配时不得改写数据字节');
});

test('nextId 紧邻上界（MAX-1）时仍可安全分配一次', () => {
  const file = writeCase('nextId-max-minus-1.json', `{"version":1,"nextId":${MAX_ID - 1},"tasks":[]}`);
  const res = runJson(['--data', file, 'add', '上界任务']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.json.task.id, MAX_ID - 1);

  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(state.nextId, MAX_ID);
  assert.ok(Number.isSafeInteger(state.nextId), 'MAX_SAFE_INTEGER 本身是安全整数');
  assert.equal(state.tasks.length, 1);

  // 再来一次就会撞上不可安全表示的 nextId+1
  const second = runJson(['--data', file, 'add', '再超出']);
  assert.equal(second.status, 1, `实际退出码 ${second.status}：${second.stderr}`);
  assert.match(second.stderr, /无法安全分配/);
});

test('数据文件中不得出现重复 ID（连续分配后逐一校验）', () => {
  const file = path.join(dir, 'sequence.json');
  for (let i = 0; i < 5; i++) {
    const res = runJson(['--data', file, 'add', `第 ${i + 1} 个`]);
    assert.equal(res.status, 0, res.stderr);
  }
  assert.equal(runCli(['--data', file, 'remove', '3']).status, 0);
  const res = runJson(['--data', file, 'add', '删除后新增']);
  assert.equal(res.status, 0, res.stderr);

  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ids = state.tasks.map((t) => t.id);
  assert.deepEqual(ids, [1, 2, 4, 5, 6], 'ID 不得复用');
  assert.equal(new Set(ids).size, ids.length, 'ID 不得重复');
  assert.ok(ids.every((id) => Number.isSafeInteger(id) && id > 0));
  assert.equal(state.nextId, 7);
  assert.ok(Number.isSafeInteger(state.nextId));
});

test('ID 参数超界/非整数报输入错误，且不触碰数据文件', () => {
  assert.equal(runCli(['--data', data, 'add', '基准任务']).status, 0);
  const before = readBytes(data);
  for (const bad of [String(MAX_ID + 1), OVER_MAX, WAY_OVER, '1e400', '1.0', 'NaN', 'Infinity']) {
    for (const cmd of ['done', 'remove']) {
      const res = runCli(['--data', data, cmd, bad, '--json']);
      assert.equal(res.status, 2, `${cmd} ${bad} 实际 ${res.status}：${res.stderr}`);
      assert.equal(res.stdout, '', `${cmd} ${bad}`);
      const parsed = JSON.parse(res.stderr);
      assert.equal(parsed.ok, false, `${cmd} ${bad}`);
      assert.equal(parsed.code, 'BAD_ID', `${cmd} ${bad}`);
    }
  }
  assert.deepEqual(readBytes(data), before, '非法 ID 不得改写数据文件');
});

test('MAX_SAFE_INTEGER 作为查询 ID 合法解析但报任务不存在', () => {
  const res = runJson(['--data', data, 'done', String(MAX_ID)]);
  assert.equal(res.status, 2);
  assert.equal(res.stdout, '');
  const parsed = JSON.parse(res.stderr);
  assert.equal(parsed.code, 'NOT_FOUND');
  assert.match(parsed.message, /任务不存在/);
});

test('完成与删除在安全整数范围内行为正常', () => {
  const file = path.join(dir, 'safe-range.json');
  assert.equal(runJson(['--data', file, 'add', '甲']).json.task.id, 1);
  assert.equal(runJson(['--data', file, 'add', '乙']).json.task.id, 2);
  assert.equal(runJson(['--data', file, 'done', '2']).json.task.done, true);
  assert.equal(runJson(['--data', file, 'remove', '1']).json.deletedId, 1);
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(state.tasks.map((t) => t.id), [2]);
  assert.equal(state.nextId, 3);
});
