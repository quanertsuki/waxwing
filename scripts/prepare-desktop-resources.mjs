import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function assertInsideResources(resources, value) {
  const relative = path.relative(resources, path.resolve(value));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to replace a path outside desktop resources: ${value}`);
  }
}

/**
 * Expand the `prototype/` entries of `package.json` `files` into the exact file
 * names the portable backend must contain.
 *
 * The manifest is the single source of truth: glob entries are matched against
 * what is on disk, negation entries are removed, and literal entries must
 * exist. A literal file that was deleted therefore fails the build instead of
 * silently disappearing from the backend, and a new `prototype/*.mjs` is
 * copied without touching this script.
 */
export function prototypeResourceFiles({root = ROOT, packageJson} = {}) {
  const manifest = packageJson
    ?? JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const entries = (manifest.files ?? [])
    .filter(entry => entry.startsWith('prototype/') || entry.startsWith('!prototype/'));
  const prototypeDir = path.join(root, 'prototype');
  const onDisk = fs.existsSync(prototypeDir)
    ? fs.readdirSync(prototypeDir, {withFileTypes: true}).filter(entry => entry.isFile()).map(entry => entry.name)
    : [];
  const files = new Set();
  const errors = [];

  for (const entry of entries) {
    if (entry.startsWith('!') || entry.endsWith('/')) continue;
    const pattern = entry.slice('prototype/'.length);
    if (pattern.includes('*')) {
      const source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*');
      const match = new RegExp(`^${source}$`);
      for (const name of onDisk) if (match.test(name)) files.add(name);
      continue;
    }
    if (onDisk.includes(pattern)) files.add(pattern);
    else errors.push(`missing packaged prototype file: prototype/${pattern}`);
  }

  for (const entry of entries) {
    if (!entry.startsWith('!')) continue;
    files.delete(entry.slice('!prototype/'.length));
  }
  return {files: [...files].sort(), errors};
}

/**
 * Rebuild `desktop/src-tauri/resources/backend` from the repository. Thin
 * wrapper around `prototypeResourceFiles` so the packaged file list and the
 * copied file list cannot drift.
 */
export function prepareDesktopResources({root = ROOT, resources} = {}) {
  const target = resources ?? path.resolve(root, 'desktop/src-tauri/resources');
  const backend = path.join(target, 'backend');
  const nodeDir = path.join(target, 'node');

  assertInsideResources(target, backend);
  assertInsideResources(target, nodeDir);

  const {files, errors} = prototypeResourceFiles({root});
  if (errors.length > 0) throw new Error(errors.join('\n'));

  fs.rmSync(backend, {recursive: true, force: true});
  fs.rmSync(nodeDir, {recursive: true, force: true});
  fs.mkdirSync(path.join(backend, 'prototype'), {recursive: true});
  fs.mkdirSync(nodeDir, {recursive: true});

  fs.cpSync(path.join(root, 'src'), path.join(backend, 'src'), {recursive: true});
  for (const name of files) {
    fs.copyFileSync(path.join(root, 'prototype', name), path.join(backend, 'prototype', name));
  }
  fs.cpSync(path.join(root, 'prototype/providers'), path.join(backend, 'prototype/providers'), {recursive: true});
  fs.copyFileSync(path.join(root, 'package.json'), path.join(backend, 'package.json'));

  const nodeSource = process.platform === 'win32'
    && fs.existsSync(path.join(path.dirname(process.execPath), 'node.exe'))
    ? path.join(path.dirname(process.execPath), 'node.exe')
    : process.execPath;
  const nodeTarget = path.join(nodeDir, process.platform === 'win32' ? 'node.exe' : 'node');
  fs.copyFileSync(nodeSource, nodeTarget);
  if (process.platform !== 'win32') fs.chmodSync(nodeTarget, 0o755);

  console.log(`Prepared desktop backend at ${backend}`);
  console.log(`Bundled Node runtime at ${nodeTarget}`);
  return {backend, files};
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) prepareDesktopResources();
