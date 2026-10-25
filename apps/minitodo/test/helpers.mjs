// MiniTodo 测试公共工具：真实 CLI 派生进程调用 + 项目内 I 盘临时目录
//
// 所有临时文件都放在 <项目>/test/tmp 下，绝不使用 C 盘系统临时目录。
//
// 关于输出捕获：本机环境的进程沙箱禁止打开命名管道，Node 的默认
// stdio:'pipe' 会直接失败（spawn EPERM）。因此这里用「派生进程 stdout/stderr
// 重定向到文件、调用进程读回文件」的方式捕获输出：仍然是真实的独立 CLI
// 进程，仍然能拿到真实退出码与两个输出流的原始内容，只是绕开了管道。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.dirname(TEST_DIR);
export const TODO_MJS = path.join(PROJECT_ROOT, 'todo.mjs');
export const TMP_ROOT = path.join(TEST_DIR, 'tmp');

let ioCounter = 0;

/** 创建独立的项目内临时目录 */
export function makeTmpDir(tag) {
  const dir = path.join(
    TMP_ROOT,
    `${tag}-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function cleanupTmpDir(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
  } catch { /* 清理失败不影响断言结论 */ }
}

/** 用真实 CLI 派生进程执行，返回真实退出码与两个输出流 */
export function runCli(args, { cwd = PROJECT_ROOT } = {}) {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const stem = `${process.pid}-${Date.now().toString(36)}-${(ioCounter += 1).toString(36)}`;
  const outFile = path.join(TMP_ROOT, `.io-${stem}.out`);
  const errFile = path.join(TMP_ROOT, `.io-${stem}.err`);
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  let res;
  try {
    res = spawnSync(process.execPath, [TODO_MJS, ...args], {
      cwd,
      stdio: ['ignore', outFd, errFd],
      windowsHide: true,
      timeout: 30_000,
    });
  } finally {
    try { fs.closeSync(outFd); } catch { /* ignore */ }
    try { fs.closeSync(errFd); } catch { /* ignore */ }
  }
  const stdout = fs.readFileSync(outFile, 'utf8');
  const stderr = fs.readFileSync(errFile, 'utf8');
  try { fs.rmSync(outFile, { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(errFile, { force: true }); } catch { /* ignore */ }
  if (res.error) throw res.error;
  return { status: res.status, stdout, stderr };
}

/** CLI 调用 + 解析 stdout JSON */
export function runJson(args, options) {
  const res = runCli([...args, '--json'], options);
  let json = null;
  try { json = JSON.parse(res.stdout); } catch { json = null; }
  return { ...res, json };
}

export function readDataFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

export function readBytes(file) {
  return fs.readFileSync(file);
}

export function writeUtf8(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}
