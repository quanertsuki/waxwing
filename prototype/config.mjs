import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const DEFAULT_HERE = path.dirname(fileURLToPath(import.meta.url));
const NESTED_KEYS = ['executionPolicy', 'usageLimits'];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readJsonFile(file, label) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`Cannot read ${label} at ${file}: ${error.message}`);
  }
  try {
    const value = JSON.parse(text);
    if (!isPlainObject(value)) throw new Error('root value must be an object');
    return value;
  } catch (error) {
    throw new Error(`Invalid ${label} at ${file}: ${error.message}`);
  }
}

function mergeConfig(base, overlay) {
  const merged = {...base, ...overlay};
  for (const key of NESTED_KEYS) {
    if (isPlainObject(base[key]) || isPlainObject(overlay[key])) {
      merged[key] = {...(isPlainObject(base[key]) ? base[key] : {}),
        ...(isPlainObject(overlay[key]) ? overlay[key] : {})};
    }
  }
  return merged;
}

function firstDefined(...values) {
  return values.find(value => value !== undefined && value !== null && value !== '');
}

function platformDataRoot(env) {
  if (env.WAXWING_HOME) return path.resolve(env.WAXWING_HOME);
  if (process.platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.join(env.USERPROFILE || env.HOME || '.', 'AppData', 'Local');
    return path.join(localAppData, 'Waxwing');
  }
  if (process.platform === 'darwin') {
    return path.join(env.HOME || '.', 'Library', 'Application Support', 'Waxwing');
  }
  return path.join(env.XDG_DATA_HOME || path.join(env.HOME || '.', '.local', 'share'), 'waxwing');
}

/** Resolve a config path relative to the directory that contains config.json. */
export function resolveConfigPath(value, baseDir) {
  if (typeof value !== 'string' || value.trim() === '') return value;
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(baseDir, value);
}

function resolveExecutable(value, baseDir) {
  if (typeof value !== 'string' || value.trim() === '') return process.execPath;
  if (path.isAbsolute(value)) return path.normalize(value);
  // A bare command such as "node" stays on PATH; a relative path is anchored
  // beside the configuration file for reproducible local setups.
  return /[\\/]/.test(value) ? path.resolve(baseDir, value) : value;
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
    throw new Error('Port must be an integer between 1 and 65535');
  }
  return port;
}

/**
 * Resolve which local-override file is in effect.
 *
 * The file must not live inside the install directory: a portable update
 * replaces `resources/backend/prototype/` and `npm update` replaces the
 * package, so settings saved there would be lost. The platform data root is
 * computed from `WAXWING_HOME` or the OS default only — never from the
 * configured `root` — so this cannot depend on the value being resolved.
 *
 * Order: explicit environment override, the new per-user location, then the
 * legacy file beside `config.json` (read-only fallback). When no file exists,
 * the new location is returned so the next save lands there.
 *
 * @returns {{path: string, source: 'env'|'home'|'legacy'|null}}
 */
export function resolveLocalConfigPath({
  explicit,
  home,
  legacy,
  exists = fs.existsSync,
} = {}) {
  if (explicit) return {path: path.resolve(explicit), source: 'env'};
  if (exists(home)) return {path: path.resolve(home), source: 'home'};
  if (exists(legacy)) return {path: path.resolve(legacy), source: 'legacy'};
  return {path: path.resolve(home), source: null};
}

/**
 * Load the public config, optional git-ignored local overrides, and environment
 * overrides. A relative path in `config.json` is anchored at the config
 * directory; a relative path in the local override is anchored at that file's
 * own directory, which may now be the per-user data directory.
 *
 * This module intentionally has no repository-specific defaults beyond a
 * sibling DSH checkout and a data directory beside the project.
 */
export function loadConfiguration({here = DEFAULT_HERE, env = process.env} = {}) {
  const configPath = (env.WAXWING_CONFIG || env.DSH_SUBAGENT_CONFIG)
    ? path.resolve(env.WAXWING_CONFIG || env.DSH_SUBAGENT_CONFIG)
    : path.join(here, 'config.json');
  const configDir = path.dirname(configPath);
  const local = resolveLocalConfigPath({
    explicit: env.WAXWING_LOCAL_CONFIG || env.DSH_SUBAGENT_LOCAL_CONFIG,
    home: path.join(platformDataRoot(env), 'config.local.json'),
    legacy: path.join(configDir, 'config.local.json'),
  });
  const localConfigPath = local.path;
  // The file's own directory is the anchor for its relative paths. For the
  // legacy location this equals the config directory, so old files keep their
  // existing meaning.
  const localBaseDir = path.dirname(localConfigPath);

  const publicConfig = readJsonFile(configPath, 'configuration');
  const localConfig = path.resolve(localConfigPath) === path.resolve(configPath)
    ? {}
    : readJsonFile(localConfigPath, 'local configuration');
  const merged = mergeConfig(publicConfig, localConfig);

  /**
   * Resolve one path-valued key from the file that supplied it: an environment
   * value is anchored at the config directory, a local override at the local
   * file, and a public value at `config.json`.
   */
  function anchor(envNames, key, fallback) {
    const fromEnvironment = firstDefined(...envNames.map(name => env[name]));
    if (fromEnvironment !== undefined) return resolveConfigPath(fromEnvironment, configDir);
    if (firstDefined(merged[key]) !== undefined) {
      return resolveConfigPath(merged[key], Object.hasOwn(localConfig, key) ? localBaseDir : configDir);
    }
    return resolveConfigPath(fallback, configDir);
  }

  const dshRepo = anchor(
    ['WAXWING_DSH_REPO', 'DSH_SUBAGENT_DSH_REPO', 'DSH_REPO'],
    'dshRepo',
    path.join(here, '..', 'deepseek-harness'),
  );
  const root = anchor(
    ['WAXWING_HOME', 'DSH_SUBAGENT_ROOT', 'DSH_PROTOTYPE_ROOT'],
    'root',
    platformDataRoot(env),
  );
  const researchRoot = anchor(
    ['WAXWING_RESEARCH_ROOT'],
    'researchRoot',
    `${root}-research`,
  );
  const rootExplicit = Boolean(firstDefined(
    env.WAXWING_HOME,
    env.DSH_SUBAGENT_ROOT,
    env.DSH_PROTOTYPE_ROOT,
    merged.root,
  ));
  const credentialsFile = anchor(
    ['WAXWING_CREDENTIALS_FILE', 'DSH_SUBAGENT_CREDENTIALS_FILE', 'DSH_CREDENTIALS_FILE'],
    'credentialsFile',
    path.join(dshRepo, 'data', '.credentials.yaml'),
  );
  const providersDir = anchor(
    ['WAXWING_PROVIDERS_DIR', 'DSH_SUBAGENT_PROVIDERS_DIR'],
    'providersDir',
    path.join(root, 'providers'),
  );
  const nodeFromEnvironment = firstDefined(
    env.WAXWING_NODE,
    env.DSH_SUBAGENT_NODE,
    env.DSH_PROTOTYPE_NODE,
  );
  const node = nodeFromEnvironment !== undefined
    ? resolveExecutable(nodeFromEnvironment, configDir)
    : resolveExecutable(
      firstDefined(merged.node, ''),
      Object.hasOwn(localConfig, 'node') ? localBaseDir : configDir,
    );
  const port = parsePort(firstDefined(
    env.WAXWING_PORT,
    env.DSH_SUBAGENT_PORT,
    env.DSH_PROTOTYPE_PORT,
    merged.port,
    43187,
  ));

  return {
    config: {
      ...merged,
      root,
      researchRoot,
      dshRepo,
      credentialsFile,
      providersDir,
      node,
      port,
      rootExplicit,
      legacyRoot: path.join(here, '..', 'data'),
    },
    configPath,
    localConfigPath,
    /** Which file supplied the local overrides (`null` when none exists). */
    localConfigSource: local.source,
  };
}
