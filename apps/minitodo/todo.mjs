#!/usr/bin/env node
// MiniTodo - 零依赖本地待办清单 CLI
// 用法见 `node todo.mjs --help`
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXIT_OK = 0;
const EXIT_STORAGE = 1;
const EXIT_USAGE = 2;
const PRIORITIES = ['high', 'normal', 'low'];
const STATUSES = ['pending', 'done', 'all'];
const SCHEMA_VERSION = 1;
const MAX_ID = Number.MAX_SAFE_INTEGER; // 9007199254740991，ID 与 nextId 的安全上界

const SELF = fileURLToPath(import.meta.url);
const PROGRAM_DIR = (() => {
  try { return path.dirname(fs.realpathSync.native(SELF)); }
  catch { return path.dirname(SELF); }
})();
const DEFAULT_DATA_FILE = path.join(PROGRAM_DIR, 'data', 'tasks.json');

const VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROGRAM_DIR, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' && pkg.version.trim() !== '' ? pkg.version : '1.0.0';
  } catch { return '1.0.0'; }
})();

class CliError extends Error {
  constructor(message, exitCode, code) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.code = code;
  }
}
const usageError = (m, c = 'USAGE') => new CliError(m, EXIT_USAGE, c);
const storageError = (m, c = 'STORAGE') => new CliError(m, EXIT_STORAGE, c);

function write(stream, text) {
  try { fs.writeSync(stream, text); }
  catch { try { process[stream === 1 ? 'stdout' : 'stderr'].write(text); } catch {} }
}
const out = (text) => write(1, text);
const err = (text) => write(2, text);

const HELP = `MiniTodo - 本地待办清单（零依赖）

用法:
  node todo.mjs add "任务标题" [--priority high|normal|low]
  node todo.mjs list [--status pending|done|all] [--priority high|normal|low|all]
  node todo.mjs done <ID>
  node todo.mjs remove <ID>
  node todo.mjs --help | --version

全局参数（命令前后均可）:
  --data <路径>   指定数据文件，默认 <程序目录>/data/tasks.json（不能为空）
  --json          以 JSON 输出（供 Agent 使用）
  --              其后的内容一律视为位置参数（标题以 - 开头时使用）

说明:
  优先级默认 normal；--priority all 等价于不按优先级过滤。
  --data / --status / --priority 的取值不能是另一个选项；取值以 - 开头时用 --data=值 或 --。
  删除任务不会回收 ID；同一个数据文件内的 ID 永不复用。
  退出码: 0 成功 / 1 存储错误（含拒绝写入 C 盘） / 2 输入错误
`;

// ---------- 参数解析 ----------
// 以 '-' 开头且长度大于 1 的记号一律视为选项，不能充当另一个选项的取值。
const isOptionToken = (token) => typeof token === 'string' && token.length > 1 && token.startsWith('-');

function parseArgs(argv) {
  const opts = {
    command: null,
    data: undefined,
    json: false,
    help: false,
    version: false,
    status: undefined,
    priority: undefined,
    positionals: [],
  };
  // 选项取值：后一个记号若缺失或是另一个选项，都算输入错误（不能静默吞掉选项）。
  const takeValue = (i, name) => {
    const v = argv[i + 1];
    if (v === undefined) throw usageError(`参数 ${name} 缺少取值`, 'EMPTY_VALUE');
    if (isOptionToken(v)) {
      throw usageError(`参数 ${name} 缺少取值，其后是另一个选项：${v}`, 'EMPTY_VALUE');
    }
    return v;
  };
  let onlyPositional = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (onlyPositional) { opts.positionals.push(a); continue; }
    if (a === '--') { onlyPositional = true; continue; }
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a === '--version' || a === '-V') { opts.version = true; continue; }
    if (a === '--data') { opts.data = takeValue(i, '--data'); i++; continue; }
    if (a === '--status') { opts.status = takeValue(i, '--status'); i++; continue; }
    if (a === '--priority') { opts.priority = takeValue(i, '--priority'); i++; continue; }
    if (a.startsWith('--data=')) { opts.data = a.slice(7); continue; }
    if (a.startsWith('--status=')) { opts.status = a.slice(9); continue; }
    if (a.startsWith('--priority=')) { opts.priority = a.slice(11); continue; }
    if (isOptionToken(a)) throw usageError(`未知参数：${a}`, 'UNKNOWN_ARG');
    if (opts.command === null) opts.command = a; else opts.positionals.push(a);
  }
  validateOptionValues(opts);
  return opts;
}

// 显式写出的取值必须是「非空白字符串」；显式空白（--data "" / --data=）是输入错误，不能回退默认值。
function validateOptionValues(opts) {
  for (const [name, value] of [['--data', opts.data], ['--status', opts.status], ['--priority', opts.priority]]) {
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.trim() === '') {
      throw usageError(`参数 ${name} 的取值不能为空`, 'EMPTY_VALUE');
    }
  }
}

// ---------- 数据路径（含 C 盘防护） ----------
function driveLetter(p) {
  let s = String(p);
  if (s.startsWith('\\\\?\\')) s = s.slice(4);
  else if (s.startsWith('\\\\.\\')) s = s.slice(4);
  if (/^UNC\\/i.test(s)) s = '\\\\' + s.slice(4);
  const m = /^([a-zA-Z]):/.exec(s);
  return m ? m[1].toLowerCase() : null;
}

// 找到路径上最近一个已存在的上级路径并解析其真实路径（用于识别联接/符号链接指向 C 盘）。
function realpathOfNearestExisting(p) {
  let cur = path.resolve(p);
  for (;;) {
    try { return fs.realpathSync.native(cur); }
    catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') return null; }
    const containingDirectory = path.dirname(cur);
    if (containingDirectory === cur) return null;
    cur = containingDirectory;
  }
}

function assertNotOnCDrive(p) {
  if (process.platform !== 'win32') return;
  const candidates = [path.resolve(p)];
  const real = realpathOfNearestExisting(p);
  if (real) candidates.push(real);
  for (const c of candidates) {
    if (driveLetter(c) === 'c') {
      throw storageError(`拒绝将数据写入 C 盘：${p}（含联接/符号链接指向 C 盘的情况）`, 'C_DRIVE_FORBIDDEN');
    }
  }
}

function resolveDataFile(dataArg) {
  // 调用方已保证：dataArg 要么是 undefined，要么是非空白字符串。
  const configured = typeof dataArg === 'string';
  const file = path.resolve(process.cwd(), configured ? dataArg : DEFAULT_DATA_FILE);
  assertNotOnCDrive(file);
  return file;
}

// ---------- 存储 ----------
function emptyState() { return { version: SCHEMA_VERSION, nextId: 1, tasks: [] }; }

function validateTitle(value, where) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw usageError(`${where}不能为空或只含空白`, 'EMPTY_TITLE');
  }
  return value;
}

// 只允许 high|normal|low|all，禁止 "high low" 这类粘连取值。
// allowAll 仅对 list 开放；add 不接受 all（all 是过滤语义，不是可存储的优先级）。
function checkPriority(value, { allowAll = false } = {}) {
  if (value === undefined) return undefined;
  if (value === 'all' && allowAll) return undefined;
  if (!PRIORITIES.includes(value)) {
    throw usageError(
      `无效优先级：${value}（可选：${allowAll ? 'high|normal|low|all' : PRIORITIES.join('|')}）`,
      'BAD_PRIORITY',
    );
  }
  return value;
}

function validateState(value, file) {
  const bad = (why) => storageError(`数据文件结构无效（${why}）：${file}`, 'CORRUPT');
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw bad('顶层必须是对象');
  if (value.version !== undefined && value.version !== SCHEMA_VERSION) throw bad(`不支持的 version=${JSON.stringify(value.version)}`);
  if (!Array.isArray(value.tasks)) throw bad('tasks 必须是数组');
  // 安全正整数：拒绝非整数、小数、负数、0 以及超出安全整数范围的值。
  if (!Number.isSafeInteger(value.nextId) || value.nextId < 1) {
    throw bad(`nextId 必须是安全正整数（实际 ${JSON.stringify(value.nextId)}）`);
  }
  const seen = new Set();
  for (const t of value.tasks) {
    if (t === null || typeof t !== 'object' || Array.isArray(t)) throw bad('任务必须是对象');
    if (!Number.isSafeInteger(t.id) || t.id < 1) {
      throw bad(`任务 id 必须是安全正整数（实际 ${JSON.stringify(t.id)}）`);
    }
    if (seen.has(t.id)) throw bad(`任务 id 重复：${t.id}`);
    seen.add(t.id);
    if (typeof t.title !== 'string' || t.title.trim() === '') throw bad(`任务 ${t.id} 的标题无效`);
    if (!PRIORITIES.includes(t.priority)) throw bad(`任务 ${t.id} 的优先级无效`);
    if (typeof t.done !== 'boolean') throw bad(`任务 ${t.id} 的 done 必须是布尔值`);
    if (typeof t.createdAt !== 'string' || t.createdAt === '') throw bad(`任务 ${t.id} 的 createdAt 无效`);
    if (!(t.completedAt === null || typeof t.completedAt === 'string')) throw bad(`任务 ${t.id} 的 completedAt 无效`);
  }
  const maxId = value.tasks.reduce((m, t) => Math.max(m, t.id), 0);
  if (value.nextId <= maxId) throw bad(`nextId=${value.nextId} 不大于最大 id=${maxId}`);
  return { version: SCHEMA_VERSION, nextId: value.nextId, tasks: value.tasks };
}

function loadState(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return emptyState();
    throw storageError(`无法读取数据文件 ${file}：${e.message}`, 'READ_FAILED');
  }
  raw = raw.replace(/^\uFEFF/, '');
  if (raw.trim() === '') throw storageError(`数据文件为空，疑似损坏：${file}`, 'CORRUPT');
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { throw storageError(`数据文件不是合法 JSON（${e.message}）：${file}`, 'CORRUPT'); }
  return validateState(parsed, file);
}

function saveState(file, state) {
  const dir = path.dirname(file);
  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (e) { throw storageError(`无法创建数据目录 ${dir}：${e.message}`, 'WRITE_FAILED'); }
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now().toString(36)}.tmp`);
  let fd;
  try {
    const text = JSON.stringify(state, null, 2) + '\n';
    fd = fs.openSync(tmp, 'wx');
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    let lastErr;
    for (let i = 1; i <= 5; i++) {
      try { fs.renameSync(tmp, file); lastErr = undefined; break; }
      catch (e) { lastErr = e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * i); }
    }
    if (lastErr) throw lastErr;
  } catch (e) {
    try { if (fd !== undefined) fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(tmp); } catch {}
    throw storageError(`写入数据文件失败 ${file}：${e.message}`, 'WRITE_FAILED');
  }
}

// ---------- 业务 ----------
function parseId(raw) {
  if (raw === undefined) throw usageError('缺少任务 ID', 'MISSING_ID');
  if (!/^\d+$/.test(raw)) throw usageError(`任务 ID 必须是正整数：${raw}`, 'BAD_ID');
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id < 1) throw usageError(`任务 ID 必须是安全正整数：${raw}`, 'BAD_ID');
  return id;
}

function noExtra(opts, allowedMax) {
  if (opts.positionals.length > allowedMax) {
    throw usageError(`多余的参数：${opts.positionals.slice(allowedMax).join(' ')}`, 'UNKNOWN_ARG');
  }
}

function nextTaskId(state, file) {
  const id = state.nextId;
  if (!Number.isSafeInteger(id) || id < 1) {
    throw storageError(`无法安全分配下一个任务 ID（nextId=${JSON.stringify(id)}）：${file}`, 'ID_EXHAUSTED');
  }
  // 分配 id 后仍须能安全保存 id+1；否则直接失败，绝不产生重复或不可表示的 ID。
  if (id >= MAX_ID) {
    throw storageError(`无法安全分配下一个任务 ID（nextId=${id} 已达到安全整数上界 ${MAX_ID}）：${file}`, 'ID_EXHAUSTED');
  }
  return id;
}

function cmdAdd(opts, file) {
  if (opts.status !== undefined) throw usageError('add 不支持 --status', 'UNKNOWN_ARG');
  if (opts.positionals.length === 0) throw usageError('缺少任务标题', 'EMPTY_TITLE');
  const title = validateTitle(opts.positionals.join(' '), '任务标题');
  const priority = checkPriority(opts.priority, { allowAll: false }) ?? 'normal';
  const state = loadState(file);
  const id = nextTaskId(state, file);
  const task = {
    id,
    title,
    priority,
    done: false,
    createdAt: new Date().toISOString(),
    completedAt: null,
  };
  state.nextId = id + 1;
  state.tasks.push(task);
  saveState(file, state);
  return { task, text: `已添加 #${task.id} [${task.priority}] ${task.title}` };
}

function cmdList(opts, file) {
  noExtra(opts, 0);
  const status = opts.status ?? 'all';
  if (!STATUSES.includes(status)) {
    throw usageError(`无效状态过滤：${status}（可选：pending|done|all）`, 'BAD_STATUS');
  }
  const priority = checkPriority(opts.priority, { allowAll: true });
  const state = loadState(file);
  const tasks = state.tasks
    .filter((t) => (status === 'all' ? true : status === 'done' ? t.done : !t.done))
    .filter((t) => (priority === undefined ? true : t.priority === priority));
  let text;
  if (tasks.length === 0) text = '（没有匹配的任务）';
  else {
    text = tasks
      .map((t) => `${t.done ? '[x]' : '[ ]'} #${t.id} [${t.priority}] ${t.title}${t.done ? ` (完成于 ${t.completedAt})` : ''}`)
      .join('\n');
  }
  return { tasks, text };
}

function cmdDone(opts, file) {
  noExtra(opts, 1);
  if (opts.status !== undefined || opts.priority !== undefined) throw usageError('done 不支持 --status/--priority', 'UNKNOWN_ARG');
  const id = parseId(opts.positionals[0]);
  const state = loadState(file);
  const task = state.tasks.find((t) => t.id === id);
  if (!task) throw usageError(`任务不存在：#${id}`, 'NOT_FOUND');
  if (!task.done) {
    // 仅首次完成写入，重复完成不修改 completedAt（幂等）。
    task.done = true;
    task.completedAt = new Date().toISOString();
    saveState(file, state);
  }
  return { task, text: `已完成 #${task.id} ${task.title}` };
}

function cmdRemove(opts, file) {
  noExtra(opts, 1);
  if (opts.status !== undefined || opts.priority !== undefined) throw usageError('remove 不支持 --status/--priority', 'UNKNOWN_ARG');
  const id = parseId(opts.positionals[0]);
  const state = loadState(file);
  const idx = state.tasks.findIndex((t) => t.id === id);
  if (idx === -1) throw usageError(`任务不存在：#${id}`, 'NOT_FOUND');
  state.tasks.splice(idx, 1);
  saveState(file, state); // nextId 保持不变，删除最高 ID 后不复用
  return { deletedId: id, text: `已删除 #${id}` };
}

// ---------- 入口 ----------
function fail(e, json) {
  const exitCode = e instanceof CliError ? e.exitCode : EXIT_STORAGE;
  const code = e instanceof CliError ? e.code : 'INTERNAL';
  const message = e && e.message ? e.message : String(e);
  if (json) err(JSON.stringify({ ok: false, code, error: message, message }, null, 2) + '\n');
  else err(`错误：${message}\n`);
  return exitCode;
}

function main(argv) {
  // 解析失败时也要能识别 --json（按原始 argv 判断），以保证错误格式一致。
  const wantsJson = argv.includes('--json');
  let opts;
  try { opts = parseArgs(argv); }
  catch (e) { return fail(e, wantsJson); }
  const wantsJsonOut = opts.json || wantsJson;
  if (opts.help) { out(HELP); return EXIT_OK; }
  if (opts.version) { out(`minitodo ${VERSION}\n`); return EXIT_OK; }
  const known = ['add', 'list', 'done', 'remove'];
  try {
    if (opts.command === null) throw usageError('缺少命令，可用命令：add、list、done、remove（--help 查看帮助）', 'NO_COMMAND');
    if (!known.includes(opts.command)) throw usageError(`未知命令：${opts.command}`, 'UNKNOWN_COMMAND');
    const file = resolveDataFile(opts.data);
    let result;
    if (opts.command === 'add') result = cmdAdd(opts, file);
    else if (opts.command === 'list') result = cmdList(opts, file);
    else if (opts.command === 'done') result = cmdDone(opts, file);
    else result = cmdRemove(opts, file);
    if (wantsJsonOut) {
      const payload = { ok: true };
      if (opts.command === 'list') payload.tasks = result.tasks;
      else if (opts.command === 'remove') payload.deletedId = result.deletedId;
      else payload.task = result.task;
      out(JSON.stringify(payload, null, 2) + '\n');
    } else {
      out(result.text + '\n');
    }
    return EXIT_OK;
  } catch (e) {
    return fail(e, wantsJsonOut);
  }
}

process.exitCode = main(process.argv.slice(2));
