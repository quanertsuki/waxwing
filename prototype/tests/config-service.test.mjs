// The configuration service is the only interpreter of provider files and
// editable settings. The desktop calls it through the manager, so these tests
// drive it directly with temp directories and an injected environment.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import './isolate.mjs';
import {
  ConfigurationService,
  DEFAULT_LIMITS,
  absolutizeLocalPaths,
} from '../../src/config/service.mjs';
import {managerPaths} from '../../src/config/paths.mjs';
import {operationByName} from '../../src/operations/catalogue.mjs';
import {createManager} from '../manager.mjs';
import {config} from '../common.mjs';
import {createFakeWorker} from './fake-worker.mjs';

function root() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'waxwing-config-service-'));
}

function serviceFor(dir, overrides = {}) {
  const config = {
    root: path.join(dir, 'data'),
    researchRoot: path.join(dir, 'research'),
    providersDir: path.join(dir, 'providers'),
    defaultProvider: 'dsh-sdk',
    fallbackProvider: 'dsh-sdk',
    model: 'deepseek-flash',
    port: 43187,
    usageLimits: {...DEFAULT_LIMITS},
    ...overrides.config,
  };
  return new ConfigurationService({
    config,
    configPath: path.join(dir, 'config.json'),
    localConfigPath: path.join(dir, 'config.local.json'),
    localConfigSource: null,
    env: {WAXWING_HOME: path.join(dir, 'home')},
    ...overrides.service,
  });
}

function writeProvider(dir, file, value) {
  fs.mkdirSync(path.join(dir, 'providers'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'providers', file), JSON.stringify(value));
}

test('providers lists valid files and reports invalid ones separately', () => {
  const dir = root();
  writeProvider(dir, 'good.json', {name: 'good', type: 'openai-chat', model: 'm', baseUrl: 'https://x'});
  writeProvider(dir, 'bad.json', {name: 'bad', type: 'unknown-type'});
  writeProvider(dir, 'notes.txt', {name: 'ignored'});
  const listed = serviceFor(dir).providers();
  assert.deepEqual(listed.providers.map(provider => provider.name), ['good']);
  assert.equal(listed.invalid.length, 1);
  assert.equal(listed.invalid[0].file, 'bad.json');
  assert.match(listed.invalid[0].error, /unknown type/);
});

test('provider saves preserve unknown fields and update the file that declares the name', () => {
  const dir = root();
  writeProvider(dir, 'custom-file.json', {
    name: 'alpha', type: 'openai-chat', model: 'old', apiKey: 'legacy-secret', note: 'keep',
  });
  const service = serviceFor(dir);
  const saved = service.saveProvider({
    name: 'alpha', type: 'openai-chat', model: 'new', baseUrl: 'https://example.invalid',
  });
  assert.equal(saved.file, path.join(dir, 'providers', 'custom-file.json'));
  const stored = JSON.parse(fs.readFileSync(saved.file, 'utf8'));
  assert.equal(stored.model, 'new');
  assert.equal(stored.apiKey, 'legacy-secret');
  assert.equal(stored.note, 'keep');
  assert.equal(fs.existsSync(path.join(dir, 'providers', 'alpha.json')), false);

  service.saveProvider({name: 'beta', type: 'dsh-sdk'});
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'providers', 'beta.json'), 'utf8')).name, 'beta');
});

test('provider validation and deletion use the same name index', () => {
  const dir = root();
  writeProvider(dir, 'renamed.json', {name: 'alpha', type: 'dsh-sdk'});
  const service = serviceFor(dir);
  assert.throws(() => service.validate({name: 'x', type: 'nope'}), /unknown type/);
  assert.throws(() => service.saveProvider({name: '../escape', type: 'dsh-sdk'}), /path separator/);
  assert.deepEqual(service.deleteProvider('alpha'), {
    deleted: true,
    name: 'alpha',
    file: path.join(dir, 'providers', 'renamed.json'),
  });
  assert.equal(fs.existsSync(path.join(dir, 'providers', 'renamed.json')), false);
  assert.throws(() => service.deleteProvider('alpha'), /Provider "alpha" not found/);
});

test('settings merge defaults, validate, and persist the complete limit set', () => {
  const dir = root();
  writeProvider(dir, 'file-provider.json', {name: 'file-provider', type: 'dsh-sdk', model: 'm'});
  const service = serviceFor(dir, {config: {usageLimits: {enabled: false, warnCostCny: 4}}});
  const current = service.settings();
  assert.equal(current.usageLimits.warnCostCny, 4);
  assert.equal(current.usageLimits.blockCostCny, DEFAULT_LIMITS.blockCostCny);

  assert.throws(() => service.saveSettings({
    defaultProvider: 'dsh-sdk',
    fallbackProvider: 'dsh-sdk',
    usageLimits: {...DEFAULT_LIMITS, warnCostCny: 9, blockCostCny: 5},
  }), /warnCostCny must be less than blockCostCny/);
  assert.throws(() => service.saveSettings({
    defaultProvider: 'missing',
    fallbackProvider: 'dsh-sdk',
    usageLimits: DEFAULT_LIMITS,
  }), /unusable provider/);

  const applied = service.saveSettings({
    defaultProvider: 'file-provider',
    fallbackProvider: 'dsh-sdk',
    usageLimits: {enabled: true, warnCostCny: 1, blockCostCny: 2, warnRequests: 3, blockRequests: 4},
  });
  assert.equal(applied.localConfigPath, path.join(dir, 'config.local.json'));
  const stored = JSON.parse(fs.readFileSync(applied.localConfigPath, 'utf8'));
  assert.equal(stored.defaultProvider, 'file-provider');
  assert.deepEqual(stored.usageLimits, applied.usageLimits);
});

test('saving a legacy local file migrates it and makes relative paths absolute', () => {
  const dir = root();
  const legacy = path.join(dir, 'prototype', 'config.local.json');
  fs.mkdirSync(path.dirname(legacy), {recursive: true});
  fs.writeFileSync(legacy, JSON.stringify({root: '../data', node: './bin/node.exe', extra: true}));
  const service = serviceFor(dir, {
    service: {localConfigPath: legacy, localConfigSource: 'legacy'},
  });
  const applied = service.saveSettings({
    defaultProvider: 'dsh-sdk',
    fallbackProvider: 'dsh-sdk',
    usageLimits: DEFAULT_LIMITS,
  });
  assert.equal(applied.localConfigPath, path.join(dir, 'home', 'config.local.json'));
  const stored = JSON.parse(fs.readFileSync(applied.localConfigPath, 'utf8'));
  assert.equal(stored.root, path.join(dir, 'data'));
  assert.equal(stored.node, path.join(dir, 'prototype', 'bin', 'node.exe'));
  assert.equal(stored.extra, true);
  assert.equal(fs.existsSync(legacy), true, 'the legacy file is read-only');
  assert.equal(absolutizeLocalPaths({node: 'node'}, dir).node, 'node');
});

test('the manager forwards settings to the Node validator and asks for a restart', async () => {
  const savedLimits = {enabled: true, warnCostCny: 1, blockCostCny: 2, warnRequests: 3, blockRequests: 4};
  const calls = [];
  const service = {
    info: () => ({dataRoot: 'unused'}),
    providers: () => ({providers: [], invalid: []}),
    validate: value => ({valid: true, name: value.name}),
    saveProvider: value => ({saved: true, name: value.name}),
    deleteProvider: name => ({deleted: true, name}),
    settings: () => ({
      defaultProvider: config.defaultProvider,
      fallbackProvider: config.fallbackProvider,
      usageLimits: config.usageLimits,
    }),
    saveSettings(value) {
      calls.push(value);
      return {defaultProvider: 'applied', fallbackProvider: 'dsh-sdk', usageLimits: savedLimits,
        localConfigPath: 'unused'};
    },
  };
  const manager = createManager({forkWorker: () => createFakeWorker({pid: 4647}), configurationService: service});
  try {
    const result = await manager.action('settings_save', {
      defaultProvider: 'file-provider',
      fallbackProvider: 'dsh-sdk',
      usageLimits: savedLimits,
    });
    assert.equal(result.saved, true);
    assert.equal(result.restartRequired, true);
    assert.deepEqual(result.settings, {
      defaultProvider: 'applied',
      fallbackProvider: 'dsh-sdk',
      usageLimits: savedLimits,
    });
    assert.deepEqual(calls, [{
      defaultProvider: 'file-provider',
      fallbackProvider: 'dsh-sdk',
      usageLimits: savedLimits,
    }]);
    assert.deepEqual(await manager.action('settings_get'), service.settings());
    assert.deepEqual(await manager.action('provider_delete', {name: 'x'}), {deleted: true, name: 'x'});
  } finally {
    await manager.shutdown();
  }
});

test('manager paths resolve from one configuration load for the launcher', () => {
  const dir = root();
  const prototype = path.join(dir, 'prototype');
  fs.mkdirSync(prototype, {recursive: true});
  fs.writeFileSync(path.join(prototype, 'config.json'), JSON.stringify({
    root: '../data',
    port: 43219,
    defaultProvider: 'dsh-sdk',
  }));
  fs.writeFileSync(path.join(prototype, 'server.mjs'), '');
  const resolved = managerPaths({
    here: prototype,
    env: {WAXWING_HOME: path.join(dir, 'data-root')},
  });
  assert.equal(resolved.dataRoot, path.join(dir, 'data-root'));
  assert.equal(resolved.tokenFile, path.join(dir, 'data-root', 'runtime', 'server-token'));
  assert.equal(resolved.managerScript, path.join(prototype, 'server.mjs'));
  assert.equal(resolved.managerDir, prototype);
  assert.equal(resolved.managerUrl, 'http://127.0.0.1:43219/api');
  assert.equal(resolved.port, 43219);
  assert.equal(resolved.localConfigPath, path.join(dir, 'data-root', 'config.local.json'));
});

test('desktop configuration operations are server and desktop only', () => {
  const names = ['config_info', 'providers_list', 'provider_validate', 'provider_save',
    'provider_delete', 'settings_get', 'settings_save'];
  for (const name of names) {
    const spec = operationByName(name);
    assert.ok(spec, `${name} must exist`);
    assert.equal(spec.entries.server, true, `${name} gateway`);
    assert.equal(spec.entries.desktop, true, `${name} desktop`);
    assert.equal(spec.entries.mcp, false, `${name} stays out of MCP`);
    assert.equal(spec.entries.cli, false, `${name} stays out of the CLI`);
  }
  assert.equal(operationByName('settings_get').annotations.readOnlyHint, true);
  assert.equal(operationByName('config_info').annotations.readOnlyHint, true);
  assert.equal(operationByName('provider_delete').annotations.destructiveHint, true);
});

test('the manager paths fixture declares the launcher contract', () => {
  const fixture = JSON.parse(fs.readFileSync(
    new URL('./fixtures/manager-paths.json', import.meta.url), 'utf8'));
  const dir = root();
  const prototype = path.join(dir, 'prototype');
  fs.mkdirSync(prototype, {recursive: true});
  fs.writeFileSync(path.join(prototype, 'config.json'), '{}');
  fs.writeFileSync(path.join(prototype, 'server.mjs'), '');
  const resolved = managerPaths({here: prototype, env: {WAXWING_HOME: path.join(dir, 'home')}});
  assert.deepEqual(Object.keys(resolved).sort(), Object.keys(fixture).sort());
  for (const key of Object.keys(fixture)) {
    assert.equal(typeof resolved[key], typeof fixture[key], `${key} type`);
  }
});
