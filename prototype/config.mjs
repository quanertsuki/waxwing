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
 * Load the public config, optional git-ignored local overrides, and environment
 * overrides. Relative filesystem paths are anchored at the config directory.
 *
 * This module intentionally has no repository-specific defaults beyond a
 * sibling DSH checkout and a data directory beside the project.
 */
export function loadConfiguration({here = DEFAULT_HERE, env = process.env} = {}) {
  const configPath = (env.WAXWING_CONFIG || env.DSH_SUBAGENT_CONFIG)
    ? path.resolve(env.WAXWING_CONFIG || env.DSH_SUBAGENT_CONFIG)
    : path.join(here, 'config.json');
  const configDir = path.dirname(configPath);
  const localConfigPath = (env.WAXWING_LOCAL_CONFIG || env.DSH_SUBAGENT_LOCAL_CONFIG)
    ? path.resolve(env.WAXWING_LOCAL_CONFIG || env.DSH_SUBAGENT_LOCAL_CONFIG)
    : path.join(configDir, 'config.local.json');

  const publicConfig = readJsonFile(configPath, 'configuration');
  const localConfig = path.resolve(localConfigPath) === path.resolve(configPath)
    ? {}
    : readJsonFile(localConfigPath, 'local configuration');
  const merged = mergeConfig(publicConfig, localConfig);

  const dshRepo = resolveConfigPath(firstDefined(
    env.WAXWING_DSH_REPO,
    env.DSH_SUBAGENT_DSH_REPO,
    env.DSH_REPO,
    merged.dshRepo,
    path.join(here, '..', 'deepseek-harness'),
  ), configDir);
  const rootValue = firstDefined(
    env.WAXWING_HOME,
    env.DSH_SUBAGENT_ROOT,
    env.DSH_PROTOTYPE_ROOT,
    merged.root,
    platformDataRoot(env),
  );
  const root = resolveConfigPath(rootValue, configDir);
  const researchRoot = resolveConfigPath(firstDefined(
    env.WAXWING_RESEARCH_ROOT,
    merged.researchRoot,
    `${root}-research`,
  ), configDir);
  const rootExplicit = Boolean(firstDefined(
    env.WAXWING_HOME,
    env.DSH_SUBAGENT_ROOT,
    env.DSH_PROTOTYPE_ROOT,
    merged.root,
  ));
  const credentialsFile = resolveConfigPath(firstDefined(
    env.WAXWING_CREDENTIALS_FILE,
    env.DSH_SUBAGENT_CREDENTIALS_FILE,
    env.DSH_CREDENTIALS_FILE,
    merged.credentialsFile,
    path.join(dshRepo, 'data', '.credentials.yaml'),
  ), configDir);
  const providersDir = resolveConfigPath(firstDefined(
    env.WAXWING_PROVIDERS_DIR,
    env.DSH_SUBAGENT_PROVIDERS_DIR,
    merged.providersDir,
    path.join(root, 'providers'),
  ), configDir);
  const node = resolveExecutable(firstDefined(
    env.WAXWING_NODE,
    env.DSH_SUBAGENT_NODE,
    env.DSH_PROTOTYPE_NODE,
    merged.node,
  ), configDir);
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
  };
}
