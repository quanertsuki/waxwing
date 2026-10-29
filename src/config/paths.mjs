// Resolved manager paths for launchers that must find the data root, token,
// and HTTP endpoint before the manager exists. This is the only resolution the
// desktop backend consumes: it asks the CLI once instead of reading config.
import path from 'node:path';
import {loadConfiguration} from '../../prototype/config.mjs';

/**
 * Resolve everything a launcher needs from one configuration load.
 * @param options.here - directory containing server.mjs (the prototype dir).
 * @param options.env - environment, injectable for tests.
 */
export function managerPaths({here, env = process.env} = {}) {
  if (!here) throw new Error('managerPaths requires the prototype directory');
  const loaded = loadConfiguration({here, env});
  const config = loaded.config;
  const dataRoot = path.resolve(config.root);
  const runtimeDir = path.join(dataRoot, 'runtime');
  return {
    dataRoot,
    runsDir: path.join(dataRoot, 'runs'),
    reportsDir: path.join(dataRoot, 'reports'),
    runtimeDir,
    researchRoot: path.resolve(config.researchRoot),
    providersDir: path.resolve(config.providersDir),
    configPath: path.resolve(loaded.configPath),
    localConfigPath: path.resolve(loaded.localConfigPath),
    localConfigSource: loaded.localConfigSource,
    node: config.node,
    port: config.port,
    managerScript: path.resolve(path.join(here, 'server.mjs')),
    managerDir: path.resolve(here),
    managerUrl: `http://127.0.0.1:${config.port}/api`,
    tokenFile: path.join(runtimeDir, 'server-token'),
  };
}
