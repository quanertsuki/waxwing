// Loopback client shared by the CLI and MCP adapters: one request shape, one
// token source, and one server launcher. The context decides which data root
// and manager script are used, so a caller cannot reach a different server
// than the one its paths describe.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {runtimeContext} from '../config/context.mjs';
import {ensureDataDirs} from '../config/data-root.mjs';

/** Environment passed to spawned agents: caches and telemetry stay local. */
export function cleanEnvironment(temp) {
  fs.mkdirSync(temp, {recursive: true});
  return {...process.env, TMP: temp, TEMP: temp, TMPDIR: temp,
    XDG_CACHE_HOME: temp, npm_config_cache: path.join(temp, 'npm'),
    PIP_CACHE_DIR: path.join(temp, 'pip'), UV_CACHE_DIR: path.join(temp, 'uv'),
    DSH_TELEMETRY_MODE: 'DISABLED', DSH_TELEMETRY_DISABLED: '1',
    DSH_MAX_TOKENS_AS_SUCCESS: 'false'};
}

export function readToken(context = runtimeContext()) {
  return fs.readFileSync(path.join(context.runtimeDir, 'server-token'), 'utf8').trim();
}

export async function request(action, args = {}, options = {}) {
  const context = options.context ?? runtimeContext();
  const waitSeconds = ['wait', 'research_wait'].includes(action) &&
    Number.isSafeInteger(args.timeoutSeconds) ? args.timeoutSeconds : 30;
  const timeoutMs = options.timeoutMs ?? (['wait', 'research_wait'].includes(action)
    ? Math.min((waitSeconds + 15) * 1000, 2_147_483_647)
    : 45000);
  const r = await fetch(`http://127.0.0.1:${context.port}/api`, {
    method: 'POST', headers: {'content-type': 'application/json', authorization: `Bearer ${readToken(context)}`},
    body: JSON.stringify({action, args}), signal: AbortSignal.timeout(timeoutMs),
  });
  const value = await r.json();
  // Only HTTP failure is a transport/protocol failure. A normal 200 task
  // record legitimately carries a historical `error` field (for example after
  // a round exhausted a small output budget); treating that as a failed call
  // would block the delegating party from viewing or reworking such a task.
  if (!r.ok) {
    const error = new Error(value.error ?? `HTTP ${r.status}`);
    error.code = value.code ?? null;
    error.status = r.status;
    throw error;
  }
  return value;
}

/**
 * Connect to the manager for this context, starting one server process when
 * nothing is listening. A server reporting a different root is never reused.
 */
export async function ensureServer(context = runtimeContext()) {
  ensureDataDirs(context);
  const health = async () => {
    const h = await request('health', {}, {context});
    if (h.root !== context.root) throw new Error('Wrong manager on selected port');
    return h;
  };
  try {
    return await health();
  } catch (error) {
    if (error.message === 'Wrong manager on selected port') throw error;
  }
  const log = fs.openSync(path.join(context.runtimeDir, 'server.log'), 'a');
  const spawnedServer = spawn(context.node, [path.join(context.here, 'server.mjs')], {
    cwd: context.here,
    env: cleanEnvironment(path.join(context.runtimeDir, 'tmp')),
    detached: true,
    windowsHide: true,
    stdio: ['ignore', log, log],
  });
  let spawnError;
  spawnedServer.on('error', error => { spawnError = error; });
  spawnedServer.unref();
  fs.closeSync(log);
  for (let i = 0; i < 80; i++) {
    if (spawnError) throw spawnError;
    await new Promise(resolve => setTimeout(resolve, 150));
    try {
      return await health();
    } catch (error) {
      if (error.message === 'Wrong manager on selected port') throw error;
    }
  }
  throw new Error(`Manager did not start; inspect ${path.join(context.runtimeDir, 'server.log')}`);
}
