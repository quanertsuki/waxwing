import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const TARGET = path.join(ROOT, 'desktop/src-tauri/target/release');
const OUTPUT = path.join(ROOT, 'dist');
const NAME = `waxwing-${VERSION}-windows-x64`;
const STAGE = path.join(OUTPUT, NAME);
const ZIP = path.join(OUTPUT, `${NAME}.zip`);
const EXE = path.join(TARGET, 'waxwing-desktop.exe');
const RESOURCES = path.join(ROOT, 'desktop/src-tauri/resources');

if (process.platform !== 'win32') throw new Error('The 0.1 portable desktop build targets Windows x64');

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function listFiles(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...listFiles(absolute));
    else if (entry.isFile()) result.push(absolute);
  }
  return result;
}

execFileSync('npm', ['run', 'desktop:resources'], {cwd: ROOT, stdio: 'inherit', shell: true});
// The portable zip is assembled below with the backend and Node sidecar. Skip
// Tauri's platform installer bundling so the build stays offline and does not
// require a WiX download.
execFileSync(
  'npm',
  ['--prefix', 'desktop', 'run', 'tauri', '--', 'build', '--no-bundle'],
  {cwd: ROOT, stdio: 'inherit', shell: true},
);
if (!fs.existsSync(EXE)) throw new Error(`Tauri executable not found: ${EXE}`);

fs.mkdirSync(OUTPUT, {recursive: true});
fs.rmSync(STAGE, {recursive: true, force: true});
fs.mkdirSync(STAGE, {recursive: true});
fs.copyFileSync(EXE, path.join(STAGE, 'waxwing.exe'));
fs.cpSync(RESOURCES, path.join(STAGE, 'resources'), {recursive: true});
fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(STAGE, 'LICENSE'));
fs.copyFileSync(path.join(ROOT, 'README.md'), path.join(STAGE, 'README.md'));
fs.copyFileSync(path.join(ROOT, 'README.zh-CN.md'), path.join(STAGE, 'README.zh-CN.md'));
fs.writeFileSync(path.join(STAGE, 'UNSIGNED.txt'),
  'This Windows build is unsigned. Windows SmartScreen may warn; verify SHA256SUMS before running.\n');

const fileChecksums = listFiles(STAGE)
  .filter(file => path.basename(file) !== 'SHA256SUMS')
  .map(file => `${sha256(file)}  ${path.relative(STAGE, file).split(path.sep).join('/')}`)
  .sort()
  .join('\n');
fs.writeFileSync(path.join(STAGE, 'SHA256SUMS'), `${fileChecksums}\n`);

if (fs.existsSync(ZIP)) fs.unlinkSync(ZIP);
execFileSync('powershell.exe', [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  `Compress-Archive -LiteralPath '${STAGE}' -DestinationPath '${ZIP}' -CompressionLevel Optimal`,
], {stdio: 'inherit', windowsHide: true});

const hash = sha256(ZIP);
fs.writeFileSync(path.join(OUTPUT, 'SHA256SUMS'), `${hash}  ${path.basename(ZIP)}\n`);
console.log(`Created ${ZIP}`);
