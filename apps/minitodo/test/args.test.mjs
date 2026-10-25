// 参数解析回归：重点覆盖「选项后跟另一个选项不得当作取值」与「显式空白取值必须报错」
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
  PROJECT_ROOT,
  TODO_MJS,
} from './helpers.mjs';

const DEFAULT_DATA = path.join(PROJECT_ROOT, 'data', 'tasks.json');

function snapshotDefault() {
  return fs.existsSync(DEFAULT_DATA) ? fs.readFileSync(DEFAULT_DATA) : null;
}

function assertDefaultUntouched(before) {
  const after = fs.existsSync(DEFAULT_DATA) ? fs.readFileSync(DEFAULT_DATA) : null;
  if (before === null) assert.equal(after, null, '默认数据文件不应当被创建');
  else assert.deepEqual(after, before, '默认数据文件不应当被改写');
}

test('--data --json list 退化为缺失取值，退出码 2', () => {
  const before = snapshotDefault();
  const res = runCli(['--data', '--json', 'list']);
  assert.equal(res.status, 2);
  assert.equal(res.stdout, '', '错误时 stdout 必须为空');
  assert.match(res.stderr, /--data/);
  assert.match(res.stderr, /缺少取值/);
  assert.match(res.stderr, /--json/);
  assertDefaultUntouched(before);
});

test('--data --priority high list 不得把 --priority 当作路径', () => {
  const before = snapshotDefault();
  const res = runCli(['--data', '--priority', 'high', 'list']);
  assert.equal(res.status, 2);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /--data/);
  assert.match(res.stderr, /--priority/);
  assertDefaultUntouched(before);
});

test('--status --json list 视为缺少取值，退出码 2', () => {
  const res = runCli(['--status', '--json', 'list']);
  assert.equal(res.status, 2);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /--status/);
  assert.match(res.stderr, /缺少取值/);
});

test('--priority --data X list 视为缺少取值，退出码 2', () => {
  const res = runCli(['--priority', '--data', 'X', 'list']);
  assert.equal(res.status, 2);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /--priority/);
  assert.match(res.stderr, /缺少取值/);
});

test('以另一个选项结尾的取值一律报输入错误', () => {
  for (const args of [['--data'], ['--status'], ['--priority']]) {
    const res = runCli([...args, '--json', 'list']);
    assert.equal(res.status, 2, `args=${args.join(' ')}`);
    assert.equal(res.stdout, '', `args=${args.join(' ')}`);
    assert.match(res.stderr, /缺少取值/, `args=${args.join(' ')}`);
  }
});

test('连写空值 --data= / --status= / --priority= 报输入错误，退出码 2', () => {
  const before = snapshotDefault();
  for (const arg of ['--data=', '--status=', '--priority=']) {
    const res = runCli(['list', arg]);
    assert.equal(res.status, 2, `arg=${arg}`);
    assert.equal(res.stdout, '', `arg=${arg}`);
    assert.match(res.stderr, /不能为空/, `arg=${arg}`);
  }
  assertDefaultUntouched(before);
});

test('显式空白 --data 必须报输入错误，不得回退默认路径', () => {
  const before = snapshotDefault();
  const res = runCli(['--data', '', 'list', '--json']);
  assert.equal(res.status, 2);
  assert.equal(res.stdout, '', 'stdout 必须为空');
  let parsed = null;
  try { parsed = JSON.parse(res.stderr); } catch { parsed = null; }
  assert.ok(parsed, `stderr 应当是 JSON：${res.stderr}`);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'EMPTY_VALUE');
  assert.match(parsed.message, /--data/);
  assertDefaultUntouched(before);
});

test('只含空白的 --data 取值同样报输入错误', () => {
  const res = runCli(['--data', '   ', 'list']);
  assert.equal(res.status, 2);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /不能为空/);
});

test('空白 --status 与空白 --priority 报输入错误', () => {
  for (const args of [['list', '--status', ''], ['list', '--priority', '   ']]) {
    const res = runCli(args);
    assert.equal(res.status, 2, `args=${args.join('|')}`);
    assert.equal(res.stdout, '', `args=${args.join('|')}`);
    assert.match(res.stderr, /不能为空/, `args=${args.join('|')}`);
  }
});

test('--data=<路径> 连写形式可用', () => {
  const dir = makeTmpDir('argdata');
  try {
    const data = path.join(dir, 'tasks.json');
    const add = runJson(['add', '连写路径', `--data=${data}`]);
    assert.equal(add.status, 0, add.stderr);
    assert.equal(add.json.ok, true);
    const listed = runJson(['--data=' + data, 'list']);
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal(listed.json.tasks.length, 1);
  } finally {
    cleanupTmpDir(dir);
  }
});

test('-- 之后的选项一律当作位置参数', () => {
  const dir = makeTmpDir('argdash');
  try {
    const data = path.join(dir, 'tasks.json');
    // 注意：-- 之后全部是位置参数，所以 --data/--json 都不能写在 -- 之后。
    const res = runCli([`--data=${data}`, 'add', '--', '--priority', 'high']);
    assert.equal(res.status, 0, res.stderr);
    const stored = readDataFile(data);
    assert.equal(stored.tasks[0].title, '--priority high');
    assert.equal(stored.tasks[0].priority, 'normal', '-- 之后的 --priority 不得生效');
  } finally {
    cleanupTmpDir(dir);
  }
});

test('-- 作为选项取值时报缺少取值', () => {
  const res = runCli(['--data', '--', 'list']);
  assert.equal(res.status, 2);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /缺少取值/);
});

test('未知参数 --bogus 报输入错误且不创建数据文件', () => {
  const before = snapshotDefault();
  const res = runCli(['list', '--bogus']);
  assert.equal(res.status, 2);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /未知参数/);
  assert.ok(fs.existsSync(TODO_MJS), '入口文件必须存在');
  assertDefaultUntouched(before);
});
