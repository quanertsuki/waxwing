// list 过滤：--status 与 --priority
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { runCli, makeTmpDir, cleanupTmpDir } from './helpers.mjs';

let dir;
let data;

test.before(() => {
  dir = makeTmpDir('filter');
  data = path.join(dir, 'tasks.json');
  const tasks = [
    ['待办高', 'high'],
    ['待办普通', 'normal'],
    ['待办低', 'low'],
  ];
  for (const [title, priority] of tasks) {
    const res = runCli(['--data', data, 'add', title, '--priority', priority]);
    assert.equal(res.status, 0, res.stderr);
  }
  // #4 高优先级已完成，#5 低优先级已完成
  assert.equal(runCli(['--data', data, 'add', '已完成高', '--priority', 'high']).status, 0);
  assert.equal(runCli(['--data', data, 'done', '4']).status, 0);
  assert.equal(runCli(['--data', data, 'add', '已完成低', '--priority', 'low']).status, 0);
  assert.equal(runCli(['--data', data, 'done', '5']).status, 0);
});

test.after(() => {
  cleanupTmpDir(dir);
});

const ids = (stdout) =>
  stdout
    .split('\n')
    .map((line) => /#(\d+)/.exec(line))
    .filter(Boolean)
    .map((m) => Number(m[1]));

test('list 默认列出全部（含已完成）', () => {
  const res = runCli(['--data', data, 'list']);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(ids(res.stdout), [1, 2, 3, 4, 5]);
});

test('--status pending 只列未完成', () => {
  const res = runCli(['--data', data, 'list', '--status', 'pending']);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(ids(res.stdout), [1, 2, 3]);
});

test('--status done 只列已完成并显示完成时间', () => {
  const res = runCli(['--data', data, 'list', '--status', 'done']);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(ids(res.stdout), [4, 5]);
  assert.match(res.stdout, /\[x\] #4 \[high\] 已完成高 \(完成于 .+\)/);
});

test('--status all 与省略等价', () => {
  const a = runCli(['--data', data, 'list', '--status', 'all']);
  const b = runCli(['--data', data, 'list']);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(a.stdout, b.stdout);
});

test('--status 可写在命令之前', () => {
  const res = runCli(['--status', 'done', '--data', data, 'list']);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(ids(res.stdout), [4, 5]);
});

test('--priority 过滤单一优先级', () => {
  const high = runCli(['--data', data, 'list', '--priority', 'high']);
  assert.equal(high.status, 0, high.stderr);
  assert.deepEqual(ids(high.stdout), [1, 4]);

  const normal = runCli(['--data', data, 'list', '--priority', 'normal']);
  assert.deepEqual(ids(normal.stdout), [2]);

  const low = runCli(['--data', data, 'list', '--priority', 'low']);
  assert.deepEqual(ids(low.stdout), [3, 5]);
});

test('--priority all 等价于不按优先级过滤', () => {
  const res = runCli(['--data', data, 'list', '--priority', 'all']);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(ids(res.stdout), [1, 2, 3, 4, 5]);
});

test('--status 与 --priority 可组合', () => {
  const res = runCli(['--data', data, 'list', '--status', 'pending', '--priority', 'high']);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(ids(res.stdout), [1]);

  const none = runCli(['--data', data, 'list', '--status', 'done', '--priority', 'normal']);
  assert.equal(none.status, 0, none.stderr);
  assert.equal(none.stdout, '（没有匹配的任务）\n');
});

test('--json list 返回 tasks 数组且过滤生效', () => {
  const res = runCli(['--data', data, 'list', '--status', 'done', '--priority', 'high', '--json']);
  assert.equal(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.tasks.length, 1);
  assert.equal(parsed.tasks[0].id, 4);
  assert.equal(parsed.tasks[0].done, true);
});

test('--json list 无匹配时 tasks 为空数组', () => {
  const res = runCli(['--data', data, 'list', '--status', 'done', '--priority', 'normal', '--json']);
  const parsed = JSON.parse(res.stdout);
  assert.deepEqual(parsed.tasks, []);
});

test('非法 --status 值报输入错误，退出码 2', () => {
  for (const bad of ['finished', 'DONE', 'pending done', '待办']) {
    const res = runCli(['--data', data, 'list', `--status=${bad}`]);
    assert.equal(res.status, 2, `--status=${bad}`);
    assert.equal(res.stdout, '', `--status=${bad}`);
    assert.match(res.stderr, /无效状态过滤/, `--status=${bad}`);
  }
});

test('非法 --priority 值报输入错误，退出码 2（含粘连与 all 之外的写法）', () => {
  for (const bad of ['HIGH', 'urgent', 'high low', '高']) {
    const res = runCli(['--data', data, 'list', `--priority=${bad}`]);
    assert.equal(res.status, 2, `--priority=${bad}`);
    assert.equal(res.stdout, '', `--priority=${bad}`);
    assert.match(res.stderr, /无效优先级/, `--priority=${bad}`);
  }
});

test('add 的 --priority 不接受 all', () => {
  const fresh = path.join(dir, 'add-all.json');
  const res = runCli(['--data', fresh, 'add', '不该成功', '--priority', 'all']);
  assert.equal(res.status, 2);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /无效优先级/);
  assert.equal(fs.existsSync(fresh), false, '失败的 add 不得创建数据文件');
});

test('list 不接受多余的位置参数', () => {
  const res = runCli(['--data', data, 'list', 'extra']);
  assert.equal(res.status, 2);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /多余的参数/);
});

test('done / remove 不接受 --status 或 --priority', () => {
  for (const args of [
    ['done', '1', '--status', 'pending'],
    ['done', '1', '--priority', 'high'],
    ['remove', '1', '--status', 'all'],
    ['remove', '1', '--priority', 'high'],
  ]) {
    const res = runCli(['--data', data, ...args]);
    assert.equal(res.status, 2, args.join(' '));
    assert.equal(res.stdout, '', args.join(' '));
    assert.match(res.stderr, /不支持/, args.join(' '));
  }
  // 失败的调用不得改动任务状态
  const pending = runCli(['--data', data, 'list', '--status', 'pending']);
  assert.deepEqual(ids(pending.stdout), [1, 2, 3]);
});

test('add 不接受 --status', () => {
  const res = runCli(['--data', data, 'add', '标题', '--status', 'pending']);
  assert.equal(res.status, 2);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /add 不支持 --status/);
});
