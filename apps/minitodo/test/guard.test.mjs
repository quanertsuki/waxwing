// 路径防护：拒绝把数据写入 C 盘，含联接/符号链接指向 C 盘的情况
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { runCli, makeTmpDir, cleanupTmpDir, PROJECT_ROOT } from './helpers.mjs';

const IS_WINDOWS = process.platform === 'win32';
const C_ROOT = `${process.env.SystemDrive || 'C:'}\\`;
const PROJECT_DRIVE = path.parse(PROJECT_ROOT).root;

// C 盘上确定存在、可用来做「最近的已存在上级路径」的目录
const C_EXISTING_DIR = fs.existsSync(`${C_ROOT}Windows`)
  ? `${C_ROOT}Windows`
  : C_ROOT;

let dir;

test.before(() => {
  dir = makeTmpDir('guard');
});

test.after(() => {
  cleanupTmpDir(dir);
});

test('直接指定 C 盘路径被拒绝，退出码 1', { skip: !IS_WINDOWS }, () => {
  const target = path.join(C_ROOT, 'minitodo-should-not-exist', 'tasks.json');
  for (const args of [
    ['--data', target, 'add', '不应写入'],
    [`--data=${target}`, 'add', '不应写入'],
    ['--data', target, 'list'],
  ]) {
    const res = runCli(args);
    assert.equal(res.status, 1, `args=${args.join(' ')} 实际 ${res.status}：${res.stderr}`);
    assert.equal(res.stdout, '', `args=${args.join(' ')} 的 stdout 必须为空`);
    assert.match(res.stderr, /C 盘|C 盘，含/, `args=${args.join(' ')}`);
    assert.equal(fs.existsSync(target), false, '不得在 C 盘生成数据文件');
  }
});

test('C 盘路径的 JSON 错误输出为 ok:false 且退出 1', { skip: !IS_WINDOWS }, () => {
  const target = path.join(C_ROOT, 'minitodo-should-not-exist', 'tasks.json');
  const res = runCli(['--data', target, 'add', '不应写入', '--json']);
  assert.equal(res.status, 1);
  assert.equal(res.stdout, '');
  const parsed = JSON.parse(res.stderr);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'C_DRIVE_FORBIDDEN');
  assert.match(parsed.message, /拒绝将数据写入 C 盘/);
});

test('C 盘上不存在的深层路径同样被拒绝（最近的已存在上级路径在 C 盘）', { skip: !IS_WINDOWS }, () => {
  const target = path.join(C_EXISTING_DIR, 'minitodo-deep', 'a', 'b', 'tasks.json');
  const res = runCli(['--data', target, 'add', '不应写入']);
  assert.equal(res.status, 1, `实际 ${res.status}：${res.stderr}`);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /C 盘/);
  assert.equal(fs.existsSync(target), false);
});

test('目录联接指向 C 盘时被拒绝', { skip: !IS_WINDOWS }, (t) => {
  const link = path.join(dir, 'link-to-c');
  try {
    fs.symlinkSync(C_EXISTING_DIR, link, 'junction');
  } catch (e) {
    t.skip(`本机不允许创建目录联接：${e.code}`);
    return;
  }
  assert.ok(fs.existsSync(link), '联接应可解析');

  const target = path.join(link, 'minitodo-link', 'tasks.json');
  const res = runCli(['--data', target, 'add', '不应写入']);
  assert.equal(res.status, 1, `实际 ${res.status}：${res.stderr}`);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /C 盘/, '联接指向 C 盘时必须拒绝');
  assert.equal(fs.existsSync(target), false, '不得通过联接在 C 盘生成数据文件');
});

test('包含 .. 的路径经联接解析到 C 盘时同样被拒绝', { skip: !IS_WINDOWS }, (t) => {
  const link = path.join(dir, 'link-dotdot');
  try {
    fs.symlinkSync(C_EXISTING_DIR, link, 'junction');
  } catch (e) {
    t.skip(`本机不允许创建目录联接：${e.code}`);
    return;
  }
  const target = path.join(link, '..', 'link-dotdot', 'dotdot.json');
  const res = runCli(['--data', target, 'add', '不应写入']);
  assert.equal(res.status, 1, `实际 ${res.status}：${res.stderr}`);
  assert.match(res.stderr, /C 盘/);
  assert.equal(fs.existsSync(target), false);
});

test('项目所在盘（I 盘）路径正常可用', { skip: PROJECT_DRIVE.toLowerCase() === 'c:\\' }, () => {
  const target = path.join(dir, 'ok', 'tasks.json');
  const add = runCli(['--data', target, 'add', '正常写入']);
  assert.equal(add.status, 0, add.stderr);
  assert.ok(fs.existsSync(target));
  const list = runCli(['--data', target, 'list']);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /正常写入/);
});

test('默认数据路径位于项目目录内且不使用系统临时目录', () => {
  const expected = path.join(PROJECT_ROOT, 'data', 'tasks.json');
  assert.ok(expected.startsWith(PROJECT_ROOT), '默认数据文件必须在程序目录内');
  assert.notEqual(path.parse(expected).root.toLowerCase(), 'c:\\', '默认数据文件不得在 C 盘');
  // 默认路径下的 list 不应写出任何文件
  const existedBefore = fs.existsSync(expected);
  const res = runCli(['list']);
  assert.equal(res.status, 0, res.stderr);
  if (!existedBefore) {
    assert.equal(fs.existsSync(expected), false, 'list 不得创建默认数据文件');
  }
});
