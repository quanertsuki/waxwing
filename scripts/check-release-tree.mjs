import {execFileSync} from 'node:child_process';
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export function walk(directory, prefix = '') {
  const files = [];
  for (const entry of readdirSync(directory, {withFileTypes: true})) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...walk(path.join(directory, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

function discoverReleaseTree(cwd = process.cwd()) {
  let root;
  let files;
  try {
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
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
    root = cwd;
    files = walk(root);
  }
  return {root, files};
}

export const required = [
  'bin/waxwing.mjs',
  'bin/waxwing-mcp.mjs',
  'desktop/src-tauri/src/tasks.rs',
  'desktop/src/assets/waxwing-mark.svg',
  'prototype/manager.mjs',
  'prototype/server.mjs',
  'src/acceptance/service.mjs',
  'src/app.mjs',
  'src/research/service.mjs',
  'src/research/state.mjs',
  'src/runtime/module.mjs',
  'src/runtime/lifecycle.mjs',
  'src/runtime/protocol.mjs',
  'src/runtime/supervisor.mjs',
  'src/tasks/change-notifier.mjs',
  'src/tasks/lifecycle.mjs',
  'src/tasks/view.mjs',
  'src/tasks/transaction.mjs',
  'src/tasks/repository.mjs',
  'src/usage/execution-policy.mjs',
  'src/usage/policy.mjs',
  'src/usage/service.mjs',
  'src/workspace/lease-manager.mjs',
];

const forbiddenRoots =
  /^(?:dispatch|handoffs|acceptance|research|data|logs|runtime|node_modules|dist|target|\.codegraph|\.local-archive)(?:\/|$)/i;
const forbiddenAnywhere =
  /(?:^|\/)(?:node_modules|target|dist|\.codegraph|\.local-archive)(?:\/|$)|(?:^|\/)(?:.*\.bak(?:[-.].*)?|final-suite\.txt|npm-final(?:\.cmd|\.txt)?|npmtest[^/]*\.txt|rm-out\.txt|tmp-[^/]+)$/i;
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

function isMachineSpecificWindowsPath(value) {
  const normalized = value.replace(/^[\s"'`(=]+/, '');
  const drivePath = /^[A-Za-z]:(?:\/|$)/.test(normalized)
    ? normalized.slice(2)
    : normalized;
  const pathParts = drivePath.split('/').filter(Boolean);
  return pathParts[0]?.toLowerCase() === 'users'
    || pathParts.some(part => part.toLowerCase() === 'ds_subagent');
}

export function findMachineSpecificPath(content) {
  const normalized = String(content).replaceAll('\\', '/');
  // Generic documentation can use a drive path such as C:/work. Personal
  // home directories and the legacy repository location are not portable.
  return [...normalized.matchAll(/(?:^|[\s"'`(=])([A-Za-z]):\/[^\s"'`<>]+/gm)]
    .some(match => isMachineSpecificWindowsPath(match[0]))
    || /(?:^|[\s"'`(])\/(?:home|Users)\/[^/\s"'`<>]+(?:\/|$)/m.test(normalized);
}

export function checkReleaseTree({root, releaseFiles} = {}) {
  const tree = root && releaseFiles ? {root, files: releaseFiles} : discoverReleaseTree();
  const presentFiles = tree.files.filter(file => existsSync(path.join(tree.root, file)));
  const errors = [];
  for (const file of required) {
    if (!presentFiles.includes(file)) errors.push(`missing required release file: ${file}`);
  }
  for (const file of presentFiles) {
    if (forbiddenRoots.test(file) || forbiddenAnywhere.test(file) || forbiddenSecret.test(file)) {
      errors.push(`forbidden release path: ${file}`);
    }
    if (!textExtensions.has(path.extname(file).toLowerCase())) continue;
    const content = readFileSync(path.join(tree.root, file), 'utf8');
    if (findMachineSpecificPath(content)) errors.push(`machine-specific path in: ${file}`);
  }
  return {errors: [...new Set(errors)], releaseFiles: presentFiles};
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const {errors, releaseFiles} = checkReleaseTree();
  if (errors.length > 0) {
    console.error(errors.join('\n'));
    process.exit(1);
  }

  console.log(`Release tree check passed: ${releaseFiles.length} release files`);
}
