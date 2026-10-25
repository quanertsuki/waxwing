import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {loadConfiguration} from '../prototype/config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty path`);
  }
  return path.resolve(value);
}

export function renderMagpiePlugin({dir, config}) {
  const agent = {
    id: 'waxwing',
    name: 'Waxwing',
    dir: requireNonEmptyString(dir, 'Waxwing directory'),
    config: requireNonEmptyString(config, 'Magpie Provider config'),
    model: 'model',
    notice: 'Waxwing reloads Provider configuration for every task; no service restart is required.',
  };
  return `// Generated for this machine by \`npm run magpie:plugin\`.
// Do not commit this file.
export const agent = ${JSON.stringify(agent, null, 2)};

export function connect({gateway}) {
  return {
    apiKey: gateway.key,
    baseUrl: gateway.url,
  };
}
`;
}

export function generateMagpiePlugin({root = ROOT, env = process.env, outputPath} = {}) {
  const loaded = loadConfiguration({here: path.join(root, 'prototype'), env});
  const target = outputPath || path.join(root, 'integrations', '.local', 'waxwing.agent.js');
  const source = renderMagpiePlugin({
    dir: root,
    config: path.join(loaded.config.providersDir, 'magpie.json'),
  });
  mkdirSync(path.dirname(target), {recursive: true});
  writeFileSync(target, source, 'utf8');
  return {outputPath: target, source};
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const {outputPath} = generateMagpiePlugin();
  console.log(`Generated ${outputPath}`);
  console.log(`Add it to Magpie with: magpie plugin add "${outputPath}"`);
}
