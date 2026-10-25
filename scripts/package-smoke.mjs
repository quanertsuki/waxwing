// Verify the published tarball in an isolated prefix: CLI help, health,
// MCP initialization/tool call, and manager shutdown.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const tempRoot = path.resolve(os.tmpdir());
const work = fs.mkdtempSync(path.join(tempRoot, 'waxwing-package-smoke-'));
const packDir = path.join(work, 'pack');
const prefix = path.join(work, 'prefix');
const dataRoot = path.join(work, 'data');
fs.mkdirSync(packDir, {recursive: true});

function cleanup() {
  const relative = path.relative(tempRoot, work);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
    try {
      fs.rmSync(work, {recursive: true, force: true, maxRetries: 20, retryDelay: 100});
    } catch (error) {
      console.error(`Package smoke cleanup skipped: ${error.message}`);
    }
  }
}

function npm(args) {
  return spawnSync('npm', args, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    windowsHide: true,
    env: {...process.env, npm_config_cache: path.join(work, 'npm-cache')},
  });
}

function assertExit(result, label) {
  if (result.status !== 0) {
    throw new Error(`${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

function commandPath(name) {
  return process.platform === 'win32'
    ? path.join(prefix, `${name}.cmd`)
    : path.join(prefix, 'bin', name);
}

function runCli(name, args, env = {}) {
  return spawnSync(commandPath(name), args, {
    cwd: work,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    windowsHide: true,
    timeout: 45_000,
    env: {...process.env, ...env},
  });
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function portIsOpen(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({host: '127.0.0.1', port});
    socket.setTimeout(500);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

async function waitForManagerStop(port) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (!(await portIsOpen(port))) return;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`manager did not stop on port ${port}`);
}

function runMcp(script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: work,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {...process.env, ...env},
    });
    let stdout = '';
    let stderr = '';
    const responses = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`MCP smoke timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 20_000);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.kill();
      const done = () => resolve({stdout, stderr, responses});
      if (child.exitCode !== null || child.signalCode !== null) done();
      else child.once('close', done);
    };
    child.stdout.on('data', chunk => {
      stdout += chunk;
      const lines = stdout.split('\n');
      stdout = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        responses.push(JSON.parse(line));
        if (responses.length === 2) finish();
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {protocolVersion: '2025-03-26'},
    })}\n`);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {name: 'waxwing_list', arguments: {}},
    })}\n`);
  });
}

try {
  const packed = npm(['pack', '--json', '--pack-destination', packDir]);
  assertExit(packed, 'npm pack');
  const result = JSON.parse(packed.stdout);
  const tarball = path.join(packDir, result[0].filename);
  assertExit(
    npm([
      'install',
      '--global',
      '--prefix',
      prefix,
      '--offline',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      tarball,
    ]),
    'global install',
  );
  const moduleRootResult = npm(['root', '--global', '--prefix', prefix]);
  assertExit(moduleRootResult, 'resolve global module root');
  const moduleRoot = moduleRootResult.stdout.trim();
  if (!moduleRoot) throw new Error('npm did not return a global module root');

  const help = runCli('waxwing', ['help']);
  assertExit(help, 'waxwing help');
  if (!help.stdout.includes('waxwing [tui')) throw new Error('CLI help does not identify the waxwing command');

  const port = await freePort();
  const env = {
    WAXWING_HOME: dataRoot,
    WAXWING_PORT: String(port),
  };
  const healthResult = runCli('waxwing', ['health'], env);
  assertExit(healthResult, 'waxwing health');
  const health = JSON.parse(healthResult.stdout);
  if (!health.waxwing || path.resolve(health.root) !== path.resolve(dataRoot)) {
    throw new Error(`health returned an unexpected manager: ${healthResult.stdout}`);
  }

  const mcp = await runMcp(
    path.join(moduleRoot, 'waxwing', 'bin', 'waxwing-mcp.mjs'),
    env,
  );
  const initialized = mcp.responses.find(response => response.id === 1);
  if (initialized?.result?.serverInfo?.name !== 'waxwing') {
    throw new Error(`MCP initialization failed: ${JSON.stringify(mcp.responses)}`);
  }
  const listed = mcp.responses.find(response => response.id === 2);
  if (listed?.result?.isError || !Array.isArray(JSON.parse(listed.result.content[0].text))) {
    throw new Error(`MCP waxwing_list failed: ${JSON.stringify(listed)}`);
  }

  const shutdown = runCli('waxwing', ['shutdown'], env);
  assertExit(shutdown, 'waxwing shutdown');
  await waitForManagerStop(port);
  console.log(`Package smoke passed: ${result[0].filename}`);
} finally {
  cleanup();
}
