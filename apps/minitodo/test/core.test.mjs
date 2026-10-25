// 核心功能：添加、列表、持久化、完成幂等、删除与 ID 不复用
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  runCli,
  runJson,
  makeTmpDir,
  cleanupTmpDir,
  readDataFile,
  readText,
  readBytes,
  writeUtf8,
} from './helpers.mjs';

let dir;
let data;

test.before(() => {
  dir = makeTmpDir('core');
  data = path.join(dir, 'tasks.json');
});

test.after(() => {
  cleanupTmpDir(dir);
});

test('list 在数据文件不存在时返回空清单，且不创建文件', () => {
  const res = runCli(['--data', data, 'list']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, '（没有匹配的任务）\n');
  assert.equal(fs.existsSync(data), false, 'list 不应创建数据文件');
});

test('add 输出中文文本并写入持久文件', () => {
  const res = runCli(['--data', data, 'add', '写单元测试']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, '已添加 #1 [normal] 写单元测试\n');
  assert.equal(res.stderr, '');

  const state = readDataFile(data);
  assert.equal(state.version, 1);
  assert.equal(state.nextId, 2);
  assert.equal(state.tasks.length, 1);
  const t = state.tasks[0];
  assert.equal(t.id, 1);
  assert.equal(t.title, '写单元测试');
  assert.equal(t.priority, 'normal');
  assert.equal(t.done, false);
  assert.equal(t.completedAt, null);
  assert.equal(typeof t.createdAt, 'string');
  assert.ok(!Number.isNaN(Date.parse(t.createdAt)), 'createdAt 必须是可解析的时间');
});

test('add --json 返回 ok:true 与 task', () => {
  const res = runJson(['--data', data, 'add', '中文任务 with spaces', '--priority', 'high']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.task.id, 2);
  assert.equal(res.json.task.title, '中文任务 with spaces');
  assert.equal(res.json.task.priority, 'high');
  assert.equal(res.json.task.done, false);
});

test('ID 跨进程持久且单调递增', () => {
  const r1 = runJson(['--data', data, 'add', '第三个']);
  const r2 = runJson(['--data', data, 'add', '第四个']);
  assert.equal(r1.json.task.id, 3);
  assert.equal(r2.json.task.id, 4);
  assert.equal(readDataFile(data).nextId, 5);
  assert.deepEqual(
    readDataFile(data).tasks.map((t) => t.id),
    [1, 2, 3, 4],
  );
});

test('list 默认按 ID 顺序列出全部任务', () => {
  const res = runCli(['--data', data, 'list']);
  assert.equal(res.status, 0);
  const lines = res.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^\[ \] #1 \[normal\] 写单元测试$/);
  assert.match(lines[1], /^\[ \] #2 \[high\] 中文任务 with spaces$/);
});

test('done 幂等：重复完成不改动完成时间，也不新增任务', () => {
  const first = runJson(['--data', data, 'done', '1']);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.json.ok, true);
  assert.equal(first.json.task.id, 1);
  assert.equal(first.json.task.done, true);
  assert.equal(typeof first.json.task.completedAt, 'string');
  const bytesAfterFirst = readBytes(data);
  const completedAt = first.json.task.completedAt;

  const second = runJson(['--data', data, 'done', '1']);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.json.task.done, true);
  assert.equal(second.json.task.completedAt, completedAt, '重复完成不得刷新完成时间');
  assert.deepEqual(readBytes(data), bytesAfterFirst, '重复完成不得改写数据文件');
  assert.equal(readDataFile(data).tasks.length, 4, '重复完成不得新增任务');
});

test('done 的中文文本输出带上任务标题', () => {
  const res = runCli(['--data', data, 'done', '2']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, '已完成 #2 中文任务 with spaces\n');
});

test('remove 返回 deletedId 并从文件中移除', () => {
  const res = runJson(['--data', data, 'remove', '4']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.deletedId, 4);
  const state = readDataFile(data);
  assert.deepEqual(state.tasks.map((t) => t.id), [1, 2, 3]);
  assert.equal(state.nextId, 5, '删除后 nextId 保持不回退');
});

test('删除最高 ID 后新任务不复用该 ID', () => {
  const res = runJson(['--data', data, 'add', '删除后新增']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.json.task.id, 5, '不得复用已删除的 #4');
  assert.deepEqual(readDataFile(data).tasks.map((t) => t.id), [1, 2, 3, 5]);
});

test('remove 与 done 对不存在的 ID 报错且不改写数据', () => {
  const before = readBytes(data);
  for (const args of [['remove', '999'], ['done', '999']]) {
    const res = runJson(['--data', data, ...args]);
    assert.equal(res.status, 2, `${args[0]} 不存在的 ID 应退出 2`);
    assert.equal(res.stdout, '');
    assert.equal(res.json, null, 'stdout 不应有 JSON');
    assert.match(res.stderr, /任务不存在/);
  }
  assert.deepEqual(readBytes(data), before, '失败的命令不得改写数据文件');
});

test('数据文件写入是 UTF-8 且没有残留临时文件', () => {
  const raw = readText(data);
  assert.match(raw, /删除后新增/, '中文必须按 UTF-8 原样写入');
  const leftovers = fs.readdirSync(dir).filter((f) => f !== 'tasks.json');
  assert.deepEqual(leftovers, [], `数据目录不应有临时文件残留：${leftovers.join(', ')}`);
});

test('JSON 文件结构稳定：字段齐全且 nextId 大于最大 ID', () => {
  const state = readDataFile(data);
  assert.equal(state.version, 1);
  for (const t of state.tasks) {
    assert.deepEqual(
      Object.keys(t).sort(),
      ['completedAt', 'createdAt', 'done', 'id', 'priority', 'title'],
    );
  }
  const maxId = state.tasks.reduce((m, t) => Math.max(m, t.id), 0);
  assert.ok(state.nextId > maxId, `nextId=${state.nextId} 必须大于 maxId=${maxId}`);
});

test('add 的标题允许中文、空格与较长文本', () => {
  const title = '整理季度汇报：包含空格 与  多个空格、标点，以及 English mixed in';
  const res = runJson(['--data', data, 'add', title]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.json.task.title, title);
  assert.equal(readDataFile(data).tasks.at(-1).title, title);
});

test('同一个数据文件可被多个进程连续读写而不丢任务', () => {
  const fresh = path.join(dir, 'concurrent.json');
  for (let i = 0; i < 3; i++) {
    const res = runJson(['--data', fresh, 'add', `连续写入 ${i + 1}`]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json.task.id, i + 1);
  }
  const state = readDataFile(fresh);
  assert.deepEqual(state.tasks.map((t) => t.id), [1, 2, 3]);
  assert.equal(state.nextId, 4);
});

test('损坏的 JSON 不会被当成空清单覆盖', () => {
  const broken = path.join(dir, 'broken.json');
  const originalText = '{"version":1,"nextId":2,"tasks":[{"id":1,"title":"半份';
  writeUtf8(broken, originalText);
  const before = readBytes(broken);

  const res = runJson(['--data', broken, 'add', '新任务']);
  assert.equal(res.status, 1, '损坏数据应退出 1（存储错误）');
  assert.equal(res.stdout, '');
  assert.equal(res.json, null);
  let parsed = null;
  try { parsed = JSON.parse(res.stderr); } catch { parsed = null; }
  assert.ok(parsed, `stderr 必须是 JSON：${res.stderr}`);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'CORRUPT');
  assert.deepEqual(readBytes(broken), before, '损坏文件必须保持原样');
});
