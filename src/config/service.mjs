// Configuration, provider files, and desktop settings are interpreted only
// here. The desktop reads and writes them through the manager, so its UI and
// the task runner cannot disagree about a provider or a limit.
import fs from 'node:fs';
import path from 'node:path';
import {atomicWriteJson} from '../storage/durable-file.mjs';
import {completeLimits} from '../usage/policy.mjs';
import {
  DEFAULT_PROVIDER_NAME,
  resolveProvider,
  validateProviderConfig,
} from '../providers/registry.mjs';
import {platformDataRoot} from './load.mjs';

/** Limit defaults used when the configuration file leaves a value out. */
export const DEFAULT_LIMITS = Object.freeze({
  enabled: false,
  warnCostCny: 3,
  blockCostCny: 5,
  warnRequests: 100,
  blockRequests: 160,
});

/** Path-valued keys that a migrated local override must make absolute. */
const PATH_KEYS = ['root', 'researchRoot', 'dshRepo', 'credentialsFile', 'providersDir'];

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireProviderName(value, label = 'Provider config') {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} requires a name`);
  }
  if (value.length > 120) throw new Error(`${label} name must be at most 120 characters`);
  if (/[\\/]/.test(value) || value === '.' || value === '..') {
    throw new Error(`${label} name cannot contain a path separator: ${value}`);
  }
  return value;
}

/**
 * A legacy local file may store relative paths. Writing it to the per-user
 * directory would resolve them against a different base, so convert each one
 * to an absolute path against the directory the old file lived in.
 */
export function absolutizeLocalPaths(config, baseDir) {
  for (const key of PATH_KEYS) {
    const value = config[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    config[key] = path.resolve(baseDir, value.trim());
  }
  const node = config.node;
  if (typeof node === 'string' && node.trim() && !path.isAbsolute(node) && /[\\/]/.test(node)) {
    config.node = path.resolve(baseDir, node.trim());
  }
  return config;
}

function readJsonObject(files, file) {
  if (!files.existsSync(file)) return {};
  const value = JSON.parse(files.readFileSync(file, 'utf8'));
  if (!plainObject(value)) throw new Error(`${file} must contain a JSON object`);
  return value;
}

/**
 * Own the configuration surface the desktop needs: resolved paths, provider
 * files, and the editable settings. Validation is the same one the task runner
 * applies, so a saved value can never be rejected later by `create`.
 */
export class ConfigurationService {
  constructor({
    config,
    configPath,
    localConfigPath,
    localConfigSource = null,
    providersDir = config?.providersDir,
    env = process.env,
    files = fs,
    atomicJson = (file, value) => atomicWriteJson(file, value, {files, mode: 0o600}),
  } = {}) {
    if (!plainObject(config)) throw new Error('ConfigurationService requires the loaded configuration');
    if (!providersDir) throw new Error('ConfigurationService requires a providers directory');
    this.config = config;
    this.configPath = configPath ?? null;
    this.localConfigPath = localConfigPath ?? null;
    this.localConfigSource = localConfigSource;
    this.providersDir = path.resolve(providersDir);
    this.env = env;
    this.files = files;
    this.atomicJson = atomicJson;
  }

  /** Resolved paths and defaults, without secrets or provider contents. */
  info() {
    const dataRoot = path.resolve(this.config.root);
    return {
      dataRoot,
      runsDir: path.join(dataRoot, 'runs'),
      reportsDir: path.join(dataRoot, 'reports'),
      researchRoot: path.resolve(this.config.researchRoot),
      providersDir: this.providersDir,
      configPath: this.configPath,
      localConfigPath: this.localConfigPath,
      localConfigSource: this.localConfigSource,
      node: this.config.node,
      port: this.config.port,
      model: this.config.model ?? null,
      defaultProvider: this.config.defaultProvider ?? DEFAULT_PROVIDER_NAME,
      fallbackProvider: this.config.fallbackProvider ?? DEFAULT_PROVIDER_NAME,
    };
  }

  settings() {
    const configured = plainObject(this.config.usageLimits) ? this.config.usageLimits : {};
    return {
      defaultProvider: this.config.defaultProvider ?? DEFAULT_PROVIDER_NAME,
      fallbackProvider: this.config.fallbackProvider ?? DEFAULT_PROVIDER_NAME,
      usageLimits: completeLimits({...DEFAULT_LIMITS, ...configured}),
    };
  }

  /** Every provider file, including ones the task runner would reject. */
  providers() {
    if (!this.files.existsSync(this.providersDir)) return {providers: [], invalid: []};
    const providers = [];
    const invalid = [];
    for (const name of this.files.readdirSync(this.providersDir)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(this.providersDir, name);
      try {
        const value = JSON.parse(this.files.readFileSync(file, 'utf8'));
        validateProviderConfig(value);
        providers.push(value);
      } catch (error) {
        invalid.push({file: name, error: error.message});
      }
    }
    providers.sort((a, b) => a.name.localeCompare(b.name));
    return {providers, invalid};
  }

  validate(config) {
    if (!plainObject(config)) throw new Error('Provider config must be an object');
    validateProviderConfig(config);
    return {valid: true, name: config.name};
  }

  #providerFile(name) {
    if (!this.files.existsSync(this.providersDir)) return null;
    for (const file of this.files.readdirSync(this.providersDir)) {
      if (!file.endsWith('.json')) continue;
      const full = path.join(this.providersDir, file);
      try {
        const value = JSON.parse(this.files.readFileSync(full, 'utf8'));
        if (value?.name === name) return full;
      } catch {
        // A damaged file cannot claim a name; it is reported by providers().
      }
    }
    return null;
  }

  saveProvider(config) {
    if (!plainObject(config)) throw new Error('Provider config must be an object');
    validateProviderConfig(config);
    const name = requireProviderName(config.name);
    const existing = this.#providerFile(name);
    const file = existing ?? path.join(this.providersDir, `${name}.json`);
    if (!existing && this.files.existsSync(file)) {
      throw new Error(`Provider file ${path.basename(file)} already exists with a different name`);
    }
    const stored = readJsonObject(this.files, file);
    // Known keys are replaced; unknown keys (for example a legacy apiKey) stay.
    for (const key of Object.keys(config)) delete stored[key];
    Object.assign(stored, config);
    this.atomicJson(file, stored);
    return {saved: true, name, file};
  }

  deleteProvider(name) {
    requireProviderName(name);
    const file = this.#providerFile(name);
    if (!file) throw new Error(`Provider "${name}" not found in ${this.providersDir}`);
    this.files.rmSync(file, {force: true});
    return {deleted: true, name, file};
  }

  #localWritePath() {
    if (this.localConfigSource !== 'legacy' || !this.localConfigPath) return this.localConfigPath;
    return path.join(platformDataRoot(this.env), 'config.local.json');
  }

  /**
   * Validate and persist the editable settings. The caller applies the
   * returned values to the running manager, so no restart is needed.
   */
  saveSettings(value = {}) {
    if (!plainObject(value)) throw new Error('Settings must be an object');
    const current = this.settings();
    const usageLimits = completeLimits({
      ...current.usageLimits,
      ...(plainObject(value.usageLimits) ? value.usageLimits : {}),
    });
    const defaultProvider = requireProviderName(
      value.defaultProvider ?? current.defaultProvider, 'defaultProvider');
    const fallbackProvider = requireProviderName(
      value.fallbackProvider ?? current.fallbackProvider, 'fallbackProvider');
    for (const name of [defaultProvider, fallbackProvider]) {
      try {
        resolveProvider(this.providersDir, name, {model: this.config.model});
      } catch (error) {
        throw new Error(`Settings refer to an unusable provider: ${error.message}`);
      }
    }

    const writePath = this.#localWritePath();
    if (!writePath) throw new Error('No local configuration path is available');
    const stored = readJsonObject(this.files, this.localConfigPath ?? writePath);
    if (writePath !== this.localConfigPath) {
      // The legacy file is read-only; make its relative paths absolute before
      // moving the content so they keep pointing at the same directories.
      absolutizeLocalPaths(stored, path.dirname(this.localConfigPath));
    }
    stored.defaultProvider = defaultProvider;
    stored.fallbackProvider = fallbackProvider;
    stored.usageLimits = usageLimits;
    this.atomicJson(writePath, stored);
    return {defaultProvider, fallbackProvider, usageLimits, localConfigPath: writePath};
  }
}
