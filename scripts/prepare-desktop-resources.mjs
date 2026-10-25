import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const RESOURCES = path.resolve(ROOT, 'desktop/src-tauri/resources');
const BACKEND = path.join(RESOURCES, 'backend');
const NODE_DIR = path.join(RESOURCES, 'node');

function assertInsideResources(value) {
  const relative = path.relative(RESOURCES, path.resolve(value));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to replace a path outside desktop resources: ${value}`);
  }
}

assertInsideResources(BACKEND);
assertInsideResources(NODE_DIR);
fs.rmSync(BACKEND, {recursive: true, force: true});
fs.rmSync(NODE_DIR, {recursive: true, force: true});
fs.mkdirSync(BACKEND, {recursive: true});
fs.mkdirSync(path.join(BACKEND, 'prototype'), {recursive: true});
fs.mkdirSync(NODE_DIR, {recursive: true});

const allowedPrototype = new Set([
  'budget-plugin.mjs',
  'budget.mjs',
  'cli.mjs',
  'client.mjs',
  'common.mjs',
  'config.example.json',
  'config.json',
  'config.local.example.json',
  'config.mjs',
  'effort.mjs',
  'execution-policy.md',
  'manager.mjs',
  'mcp.mjs',
  'pricing.json',
  'server.mjs',
  'state.mjs',
  'usage.mjs',
  'worker.mjs',
]);

fs.cpSync(path.join(ROOT, 'src'), path.join(BACKEND, 'src'), {recursive: true});
for (const name of allowedPrototype) {
  const source = path.join(ROOT, 'prototype', name);
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(BACKEND, 'prototype', name));
}
fs.cpSync(path.join(ROOT, 'prototype/providers'), path.join(BACKEND, 'prototype/providers'), {recursive: true});
fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(BACKEND, 'package.json'));

const nodeSource = process.platform === 'win32'
  ? (fs.existsSync(path.join(path.dirname(process.execPath), 'node.exe'))
    ? path.join(path.dirname(process.execPath), 'node.exe')
    : process.execPath)
  : process.execPath;
const nodeTarget = path.join(NODE_DIR, process.platform === 'win32' ? 'node.exe' : 'node');
fs.copyFileSync(nodeSource, nodeTarget);
if (process.platform !== 'win32') fs.chmodSync(nodeTarget, 0o755);

console.log(`Prepared desktop backend at ${BACKEND}`);
console.log(`Bundled Node runtime at ${nodeTarget}`);
