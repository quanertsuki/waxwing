import {execFileSync} from 'node:child_process';
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import path from 'node:path';

function walk(directory, prefix = '') {
  const files = [];
  for (const entry of readdirSync(directory, {withFileTypes: true})) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...walk(path.join(directory, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

let root;
let files;
try {
  root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
    .map(file => file.replaceAll('\\', '/'));
} catch {
  root = process.cwd();
  files = walk(root);
}

const required = [
  'bin/waxwing.mjs',
  'bin/waxwing-mcp.mjs',
  'desktop/src-tauri/src/tasks.rs',
  'desktop/src/assets/waxwing-mark.svg',
  'prototype/manager.mjs',
  'prototype/server.mjs',
  'src/acceptance/service.mjs',
  'src/app.mjs',
  'src/runtime/protocol.mjs',
  'src/runtime/supervisor.mjs',
  'src/workspace/lease-manager.mjs',
];

const forbiddenRoots =
  /^(?:dispatch|handoffs|acceptance|research|data|logs|runtime|node_modules|dist|target|\.codegraph|\.local-archive)(?:\/|$)/i;
const forbiddenAnywhere =
  /(?:^|\/)(?:node_modules|target|dist|\.codegraph|\.local-archive)(?:\/|$)/i;
const forbiddenSecret =
  /(?:^|\/)(?:\.env(?:\..*)?|server-token|.*\.credentials.*|.*\.grant\.json|.*\.(?:pem|key|p12|pfx))$/i;
const textExtensions = new Set([
  '',
  '.cmd',
  '.css',
  '.html',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.ps1',
  '.rs',
  '.sh',
  '.svg',
  '.toml',
  '.ts',
  '.vue',
  '.xml',
  '.yml',
  '.yaml',
]);
const machinePaths = [
  ['C:', 'Users', '16955'].join('\\'),
  ['I:', 'DS_subagent'].join('\\'),
];
const presentFiles = files.filter(file => existsSync(path.join(root, file)));

const errors = [];
for (const file of required) {
  if (!presentFiles.includes(file)) errors.push(`missing required release file: ${file}`);
}
for (const file of presentFiles) {
  if (forbiddenRoots.test(file) || forbiddenAnywhere.test(file) || forbiddenSecret.test(file)) {
    errors.push(`forbidden release path: ${file}`);
  }
  if (!textExtensions.has(path.extname(file).toLowerCase())) continue;
  const content = readFileSync(path.join(root, file), 'utf8');
  if (machinePaths.some(value => content.toLowerCase().includes(value.toLowerCase()))) {
    errors.push(`machine-specific path in: ${file}`);
  }
}

if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exit(1);
}

console.log(`Release tree check passed: ${presentFiles.length} release files`);
