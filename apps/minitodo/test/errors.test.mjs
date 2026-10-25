// 输入错误、损坏数据保护、help/version 不产生数据文件、错误 JSON 输出
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
  TMP_ROOT,
  PROJECT_ROOT,
} from './helpers.mjs';

let dir;
let data;

test.before(() => {
  dir = makeTmpDir('errors');
  data = path.join(dir, 'tasks.json');
  assert.equal(runCli(['--data', data, 'add', '示例任务', '--priority', 'high']).status, 0);
});

test.after(() => {
  cleanupTmpDir(dir);
});

function expectUsage(args, pattern, { json = false } = {}) {
  const res = json ? runCli([...args, '--json']) : runCli(args);
  assert.equal(res.status, 2, `args=${args.join(' ')} stderr=${res.stderr}`);
  assert.equal(res.stdout, '', `args=${args.join(' ')} 的 stdout 必须为空`);
  if (json) {
    let parsed = null;
    try { parsed = JSON.parse(res.stderr); } catch { parsed = null; }
    assert.ok(parsed, `stderr 必须是 JSON：${res.stderr}`);
    assert.equal(parsed.ok, false);
    assert.match(parsed.message ?? parsed.error ?? '', pattern);
  } else {
    assert.match(res.stderr, pattern, `args=${args.join(' ')}`);
  }
  return res;
}

test('空白标题报输入错误', () => {
  expectUsage(['--data', data, 'add', ''], /标题不能为空/);
  expectUsage(['--data', data, 'add', '   '], /标题不能为空/);
  expectUsage(['--data', data, 'add', '\t\n '], /标题不能为空/);
  expectUsage(['--data', data, 'add', '', ''], /标题不能为空/);
  expectUsage(['--data', data, 'add', '  ', '--', '  '], /标题不能为空/);
});

test('缺少标题报输入错误', () => {
  expectUsage(['--data', data, 'add'], /缺少任务标题/);
});

test('非法优先级报输入错误', () => {
  expectUsage(['--data', data, 'add', '标题', '--priority', 'urgent'], /无效优先级/);
  expectUsage(['--data', data, 'add', '标题', '--priority', 'HIGH'], /无效优先级/);
  expectUsage(['--data', data, 'add', '标题', '--priority', 'high low'], /无效优先级/);
});

test('非正整数 ID 报输入错误', () => {
  for (const bad of ['0', '1.5', 'abc', '', '1e3', '0x10', '１２３', '+1', ' 1']) {
    expectUsage(['--data', data, 'done', bad], /任务 ID 必须是|缺少任务 ID/);
    expectUsage(['--data', data, 'remove', bad], /任务 ID 必须是|缺少任务 ID/);
  }
});

test('以 - 开头的 ID 被当作未知参数拒绝（同样退出 2）', () => {
  for (const bad of ['-1', '-0', '--1']) {
    expectUsage(['--data', data, 'done', bad], /未知参数|任务 ID 必须是/);
    expectUsage(['--data', data, 'remove', bad], /未知参数|任务 ID 必须是/);
  }
});

test('缺少 ID 报输入错误', () => {
  expectUsage(['--data', data, 'done'], /缺少任务 ID/);
  expectUsage(['--data', data, 'remove'], /缺少任务 ID/);
});

test('未知命令报输入错误', () => {
  expectUsage(['--data', data, 'frobnicate'], /未知命令/);
  expectUsage(['--data', data, 'Add', '标题'], /未知命令/);
});

test('缺少命令报输入错误', () => {
  expectUsage(['--data', data], /缺少命令/);
  expectUsage(['--data', data, '--json'], /缺少命令/, { json: true });
});

test('未知参数报输入错误', () => {
  expectUsage(['--data', data, 'list', '--verbose'], /未知参数/);
  expectUsage(['--data', data, '--datax', 'list'], /未知参数/);
  expectUsage(['--data', data, '-x'], /未知参数/);
});

test('多余的位置参数报输入错误', () => {
  expectUsage(['--data', data, 'done', '1', '2'], /多余的参数/);
  expectUsage(['--data', data, 'remove', '1', '2'], /多余的参数/);
});

test('JSON 模式下错误写 stderr、stdout 为空且 ok:false', () => {
  const before = readBytes(data);
  const res = runCli(['--data', data, 'add', '', '--json']);
  assert.equal(res.status, 2);
  assert.equal(res.stdout, '', 'stdout 必须为空');
  const parsed = JSON.parse(res.stderr);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'EMPTY_TITLE');
  assert.equal(typeof parsed.message, 'string');
  assert.equal(typeof parsed.error, 'string');
  assert.deepEqual(readBytes(data), before, '输入错误不得改写数据');
});

test('输入错误不产生数据文件（在不存在的数据路径上）', () => {
  const fresh = path.join(dir, 'never-created.json');
  for (const args of [
    ['add', ''],
    ['add', '标题', '--priority', 'bad'],
    ['done', 'x'],
    ['remove', '0'],
    ['frobnicate'],
    ['list', '--status', 'bad'],
  ]) {
    const res = runCli(['--data', fresh, ...args]);
    assert.equal(res.status, 2, args.join(' '));
    assert.equal(fs.existsSync(fresh), false, `输入错误不得创建文件：${args.join(' ')}`);
  }
});

test('损坏文件：非法 JSON 退出 1 且字节不变', () => {
  const file = path.join(dir, 'corrupt-json.json');
  const text = '{ "version": 1, "nextId": 3, "tasks": [ {"id": 1, ';
  writeUtf8(file, text);
  const before = readBytes(file);
  const res = runCli(['--data', file, 'list', '--json']);
  assert.equal(res.status, 1);
  assert.equal(res.stdout, '');
  const parsed = JSON.parse(res.stderr);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'CORRUPT');
  assert.deepEqual(readBytes(file), before);
});

test('损坏文件：空文件退出 1 且不覆盖', () => {
  const file = path.join(dir, 'empty.json');
  writeUtf8(file, '   \n');
  const before = readBytes(file);
  const res = runCli(['--data', file, 'add', '不该写入']);
  assert.equal(res.status, 1);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /损坏|为空/);
  assert.deepEqual(readBytes(file), before);
});

test('结构错误的数据文件退出 1 且不被覆盖（多种结构）', () => {
  const cases = {
    'array.json': '[]',
    'string.json': '"just a string"',
    'no-tasks.json': '{"version":1,"nextId":1}',
    'tasks-object.json': '{"version":1,"nextId":1,"tasks":{}}',
    'task-not-object.json': '{"version":1,"nextId":2,"tasks":[1]}',
    'title-empty.json': '{"version":1,"nextId":2,"tasks":[{"id":1,"title":"","priority":"normal","done":false,"createdAt":"2026-01-01T00:00:00.000Z","completedAt":null}]}',
    'title-missing.json': '{"version":1,"nextId":2,"tasks":[{"id":1,"priority":"normal","done":false,"createdAt":"2026-01-01T00:00:00.000Z","completedAt":null}]}',
    'priority-bad.json': '{"version":1,"nextId":2,"tasks":[{"id":1,"title":"a","priority":"urgent","done":false,"createdAt":"2026-01-01T00:00:00.000Z","completedAt":null}]}',
    'done-not-bool.json': '{"version":1,"nextId":2,"tasks":[{"id":1,"title":"a","priority":"normal","done":"yes","createdAt":"2026-01-01T00:00:00.000Z","completedAt":null}]}',
    'createdAt-missing.json': '{"version":1,"nextId":2,"tasks":[{"id":1,"title":"a","priority":"normal","done":false,"completedAt":null}]}',
    'completedAt-bad.json': '{"version":1,"nextId":2,"tasks":[{"id":1,"title":"a","priority":"normal","done":true,"createdAt":"2026-01-01T00:00:00.000Z","completedAt":123}]}',
    'id-zero.json': '{"version":1,"nextId":1,"tasks":[{"id":0,"title":"a","priority":"normal","done":false,"createdAt":"2026-01-01T00:00:00.000Z","completedAt":null}]}',
    'id-dup.json': '{"version":1,"nextId":3,"tasks":[{"id":1,"title":"a","priority":"normal","done":false,"createdAt":"2026-01-01T00:00:00.000Z","completedAt":null},{"id":1,"title":"b","priority":"normal","done":false,"createdAt":"2026-01-01T00:00:00.000Z","completedAt":null}]}',
    'nextId-small.json': '{"version":1,"nextId":1,"tasks":[{"id":1,"title":"a","priority":"normal","done":false,"createdAt":"2026-01-01T00:00:00.000Z","completedAt":null}]}',
    'nextId-zero.json': '{"version":1,"nextId":0,"tasks":[]}',
    'version-bad.json': '{"version":99,"nextId":1,"tasks":[]}',
  };
  for (const [name, text] of Object.entries(cases)) {
    const file = path.join(dir, name);
    writeUtf8(file, text);
    const before = readBytes(file);
    const res = runCli(['--data', file, 'add', '不应写入', '--json']);
    assert.equal(res.status, 1, `${name} 应退出 1，实际 ${res.status}：${res.stderr}`);
    assert.equal(res.stdout, '', `${name} stdout 必须为空`);
    const parsed = JSON.parse(res.stderr);
    assert.equal(parsed.ok, false, name);
    assert.equal(parsed.code, 'CORRUPT', `${name} 应为 CORRUPT，实际 ${parsed.code}`);
    assert.deepEqual(readBytes(file), before, `${name} 文件必须保持原样`);
  }
});

test('help 与 version 不创建也不修改数据文件', () => {
  const fresh = path.join(dir, 'help-untouched.json');
  const help = runCli(['--data', fresh, '--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /用法:/);
  assert.match(help.stdout, /--data/);
  assert.match(help.stdout, /退出码/);
  assert.equal(help.stderr, '');
  assert.equal(fs.existsSync(fresh), false, '--help 不得创建数据文件');

  const version = runCli(['--data', fresh, '--version']);
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /^minitodo \d+\.\d+\.\d+/);
  assert.equal(fs.existsSync(fresh), false, '--version 不得创建数据文件');

  // -h / -V 等价
  assert.equal(runCli(['-h']).status, 0);
  assert.equal(runCli(['-V']).status, 0);

  // --help 优先于其它输入错误
  const mixed = runCli(['--help', 'add', '']);
  assert.equal(mixed.status, 0, mixed.stderr);
  assert.match(mixed.stdout, /MiniTodo/);
});

test('version 与 package.json 保持一致', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  const res = runCli(['--version']);
  assert.equal(res.stdout.trim(), `minitodo ${pkg.version}`);
});

test('相对 --data 相对调用者 CWD 解析，而默认数据文件相对程序目录', () => {
  // 相对路径：以调用者 CWD 为基准
  const rel = path.relative(PROJECT_ROOT, path.join(dir, 'cwd-relative.json'));
  const fromProject = runCli(['--data', rel, 'add', '来自项目目录']);
  assert.equal(fromProject.status, 0, fromProject.stderr);
  assert.ok(fs.existsSync(path.join(dir, 'cwd-relative.json')));

  // 换一个 CWD 执行：路径应相对新的 CWD 解析（测试后清理该临时产物）
  const altCwd = path.join(dir, 'alt-cwd');
  fs.mkdirSync(altCwd, { recursive: true });
  const altTarget = path.join(altCwd, 'alt.json');
  const fromOutside = runCli(['--data', 'alt.json', 'add', '来自外部目录'], { cwd: altCwd });
  assert.equal(fromOutside.status, 0, fromOutside.stderr);
  assert.ok(fs.existsSync(altTarget), '相对路径应相对调用者 CWD 解析');
  assert.equal(JSON.parse(fs.readFileSync(altTarget, 'utf8')).tasks.length, 1);
  fs.rmSync(altTarget, { force: true });

  // 不带 --data 时，默认数据位置跟随程序目录而不是 CWD
  const defaultList = runCli(['list'], { cwd: altCwd });
  assert.equal(defaultList.status, 0, defaultList.stderr);
});
