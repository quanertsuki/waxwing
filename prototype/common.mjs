import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {loadConfiguration} from './config.mjs';
export const HERE = path.dirname(fileURLToPath(import.meta.url));
const loaded = loadConfiguration({here: HERE});
export const config = loaded.config;
export const CONFIG_PATH = loaded.configPath;
export const LOCAL_CONFIG_PATH = loaded.localConfigPath;

/**
 * Comparison form of a path: absolute, no trailing separator, and lowercased
 * on Windows (where path comparison is case-insensitive). This is deliberately
 * only a lexical normalisation; use canonicalExistingPath when links matter.
 * @param value - path to normalise.
 * @returns comparison key.
 */
export function canonicalPath(value) {
  if (typeof value !== 'string' || value === '') throw new Error('A nonempty path is required');
  let p = path.resolve(value);
  const root = path.parse(p).root;
  while (p.length > root.length && (p.endsWith(path.sep) || p.endsWith('/'))) p = p.slice(0, -1);
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/**
 * Comparison form of an existing path after resolving symlinks and directory
 * junctions. A missing path is an error: callers use this for workspaces and
 * managed roots that must already exist.
 * @param value - existing path.
 * @returns real comparison key.
 */
export function canonicalExistingPath(value) {
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved)) throw new Error(`Path does not exist: ${resolved}`);
  return canonicalPath(fs.realpathSync(resolved));
}

/** True when the path is a filesystem/drive root such as C:\ or /. */
export function isDriveRoot(value) {
  const resolved = path.resolve(value);
  return canonicalPath(resolved) === canonicalPath(path.parse(resolved).root);
}

/**
 * True when `candidate` is `ancestor` itself or is inside it. Comparison is
 * component-aware: "C:\work" is not an ancestor of "C:\workshop".
 * @param candidate - possible descendant.
 * @param ancestor - possible ancestor.
 * @returns whether candidate is equal to or below ancestor.
 */
export function sameOrDescendantPath(candidate, ancestor) {
  const c = canonicalPath(candidate), a = canonicalPath(ancestor);
  if (c === a) return true;
  const prefix = a.endsWith(path.sep) ? a : a + path.sep;
  return c.startsWith(prefix);
}

/** True when either path is equal to, an ancestor of, or a descendant of the other. */
export function pathsOverlap(a, b) {
  return sameOrDescendantPath(a, b) || sameOrDescendantPath(b, a);
}
export const ROOT = path.resolve(config.root);
export const RUNS = path.join(ROOT, 'runs');
export const REPORTS = path.join(ROOT, 'reports');
export const RUNTIME = path.join(ROOT, 'runtime');
/**
 * Copy legacy task data into the new data root. The source directory is never
 * modified, and a non-empty target is refused rather than merged or replaced.
 * Parameters are injectable so this safety boundary can be tested without
 * starting another manager.
 */
export function migrateLegacyData(options = {}) {
  const targetRoot = path.resolve(options.targetRoot ?? ROOT);
  const explicitlyConfigured = options.rootExplicit ?? config.rootExplicit;
  if (explicitlyConfigured) return;
  const legacyRoot = options.legacyRoot ?? config.legacyRoot;
  if (!legacyRoot) return;
  const resolvedLegacyRoot = path.resolve(legacyRoot);
  if (canonicalPath(resolvedLegacyRoot) === canonicalPath(targetRoot)) return;
  const marker = path.join(targetRoot, '.migration.json');
  if (fs.existsSync(marker)) return;
  const names = ['runs', 'reports', 'providers'].filter(name =>
    fs.existsSync(path.join(resolvedLegacyRoot, name)));
  if (names.length === 0) return;
  if (fs.existsSync(targetRoot)) {
    const existing = fs.readdirSync(targetRoot).filter(name => name !== '.migration.json');
    if (existing.length > 0) {
      throw new Error(`Legacy data migration blocked: new data directory ${targetRoot} is not empty; old data was retained at ${resolvedLegacyRoot}`);
    }
  }
  fs.mkdirSync(targetRoot, {recursive: true});
  const copied = [];
  try {
    for (const name of names) {
      const source = path.join(resolvedLegacyRoot, name);
      const destination = path.join(targetRoot, name);
      fs.cpSync(source, destination, {recursive: true, force: false, errorOnExist: true});
      copied.push(name);
    }
    atomicJson(marker, {
      from: resolvedLegacyRoot,
      copied,
      migratedAt: new Date().toISOString(),
      policy: 'copy-only-legacy-data-retained',
    });
  } catch (error) {
    throw new Error(`Legacy data migration failed; old data remains at ${resolvedLegacyRoot}: ${error.message}`);
  }
}
export function ensureDirs() {
  migrateLegacyData();
  for (const p of [RUNS, REPORTS, RUNTIME]) fs.mkdirSync(p, {recursive:true});
}
export function atomicJson(file, data) {
  fs.mkdirSync(path.dirname(file), {recursive:true});
  const temporary = `${file}.${process.pid}.${randomUUID()}.new`;
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2), {mode:0o600});
  // Windows antivirus/indexers can briefly hold the destination open, turning
  // a valid replace into EPERM or EACCES. Retry the rename without ever writing
  // the destination in place, so readers still see either old or new JSON.
  const transient = new Set(['EPERM', 'EACCES', 'EBUSY']);
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(temporary, file);
      return;
    } catch (error) {
      if (!transient.has(error.code) || attempt >= 20) {
        try { fs.unlinkSync(temporary); } catch {}
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1));
    }
  }
}
export function cleanEnvironment(temp) {
  fs.mkdirSync(temp, {recursive:true});
  return {...process.env, TMP:temp, TEMP:temp, TMPDIR:temp,
    XDG_CACHE_HOME:temp, npm_config_cache:path.join(temp,'npm'),
    PIP_CACHE_DIR:path.join(temp,'pip'), UV_CACHE_DIR:path.join(temp,'uv'),
    DSH_TELEMETRY_MODE:'DISABLED', DSH_TELEMETRY_DISABLED:'1',
    DSH_MAX_TOKENS_AS_SUCCESS:'false'};
}
export function readToken() {
  return fs.readFileSync(path.join(RUNTIME, 'server-token'), 'utf8').trim();
}
export async function request(action, args={}, options={}) {
  const waitSeconds = ['wait', 'research_wait'].includes(action) &&
    Number.isSafeInteger(args.timeoutSeconds) ? args.timeoutSeconds : 30;
  const timeoutMs = options.timeoutMs ?? (['wait', 'research_wait'].includes(action)
    ? Math.min((waitSeconds + 15) * 1000, 2_147_483_647)
    : 45000);
  const r = await fetch(`http://127.0.0.1:${config.port}/api`, {
    method:'POST', headers:{'content-type':'application/json', authorization:`Bearer ${readToken()}`},
    body:JSON.stringify({action,args}), signal:AbortSignal.timeout(timeoutMs),
  });
  const value = await r.json();
  // Only HTTP failure is a transport/protocol failure. A normal 200 task
  // record legitimately carries a historical `error` field (for example after
  // a round exhausted a small output budget); treating that as a failed call
  // would block the delegating party from viewing or reworking such a task.
  if (!r.ok) throw new Error(value.error ?? `HTTP ${r.status}`);
  return value;
}
