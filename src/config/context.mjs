// One runtime context: the resolved configuration plus every directory the
// manager derives from it. Modules receive this object instead of importing
// process-global state, so two managers with different data roots can coexist
// in one process.
import path from 'node:path';
import {loadConfiguration, PROTOTYPE_DIR} from './load.mjs';

export {PROTOTYPE_DIR};

/**
 * Build a frozen context around one resolved configuration.
 * @param options.here - backend directory owning config.json and scripts.
 * @param options.env - environment overrides.
 * @param options.platform - platform for data-root and path casing rules.
 */
export function createRuntimeContext({
  here = PROTOTYPE_DIR,
  env = process.env,
  platform = process.platform,
} = {}) {
  const loaded = loadConfiguration({here, env, platform});
  const config = Object.freeze(loaded.config);
  const root = path.resolve(config.root);
  return Object.freeze({
    here,
    config,
    configPath: loaded.configPath,
    localConfigPath: loaded.localConfigPath,
    localConfigSource: loaded.localConfigSource,
    root,
    runsDir: path.join(root, 'runs'),
    reportsDir: path.join(root, 'reports'),
    runtimeDir: path.join(root, 'runtime'),
    researchDir: path.join(root, 'research'),
    providersDir: config.providersDir,
    pricingFile: path.join(here, 'pricing.json'),
    node: config.node,
    port: config.port,
    platform,
  });
}

let defaultContext;

/**
 * The process-wide context used by launchers that have no assembly point of
 * their own (CLI, MCP). Resolved lazily on first use, never at import time.
 */
export function runtimeContext() {
  return defaultContext ??= createRuntimeContext();
}

/** The resolved configuration of the process-wide context. */
export function getConfig() {
  return runtimeContext().config;
}
