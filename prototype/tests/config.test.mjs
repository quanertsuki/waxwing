// Portable configuration layering and path resolution.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadConfiguration} from '../config.mjs';
import {migrateLegacyData} from '../common.mjs';

const LOCAL_CONFIG_FIXTURE = JSON.parse(
  fs.readFileSync(new URL('./fixtures/local-config-location.json', import.meta.url), 'utf8'),
);

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-subagent-config-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}

/** Replace the fixture placeholders with this run's temporary directories. */
function fill(template, {base, home, config, cwd}) {
  return template
    .replaceAll('{base}', base)
    .replaceAll('{home}', home)
    .replaceAll('{config}', config)
    .replaceAll('{cwd}', cwd);
}

/** Keep the platform data directory inside the fixture on every OS. */
function isolatedPlatformEnv(dir) {
  return {
    LOCALAPPDATA: path.join(dir, 'appdata'),
    HOME: path.join(dir, 'home-directory'),
    XDG_DATA_HOME: path.join(dir, 'xdg-data'),
  };
}

/** The per-user data root those isolated variables produce. */
function platformHome(dir) {
  if (process.platform === 'win32') return path.join(dir, 'appdata', 'Waxwing');
  if (process.platform === 'darwin') {
    return path.join(dir, 'home-directory', 'Library', 'Application Support', 'Waxwing');
  }
  return path.join(dir, 'xdg-data', 'waxwing');
}

test('configuration resolves public paths, local overrides, and environment overrides', t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    root: '../public-data',
    dshRepo: '../public-dsh',
    credentialsFile: '../public-dsh/credentials.yaml',
    providersDir: '../public-providers',
    node: './bin/custom-node',
    port: 43187,
    usageLimits: {enabled: false, warnRequests: 10, blockRequests: 20},
  }));
  fs.writeFileSync(path.join(dir, 'config.local.json'), JSON.stringify({
    root: './local-data',
    providersDir: './local-providers',
    usageLimits: {enabled: true},
  }));

  const local = loadConfiguration({here: dir, env: isolatedPlatformEnv(dir)});
  assert.equal(local.localConfigPath, path.join(dir, 'config.local.json'));
  assert.equal(local.localConfigSource, 'legacy');
  assert.equal(local.config.root, path.resolve(dir, 'local-data'));
  assert.equal(local.config.researchRoot, path.resolve(dir, 'local-data-research'));
  assert.equal(local.config.dshRepo, path.resolve(dir, '../public-dsh'));
  assert.equal(local.config.credentialsFile, path.resolve(dir, '../public-dsh/credentials.yaml'));
  assert.equal(local.config.providersDir, path.resolve(dir, 'local-providers'));
  assert.equal(local.config.node, path.resolve(dir, 'bin/custom-node'));
  assert.equal(local.config.usageLimits.enabled, true);
  assert.equal(local.config.usageLimits.warnRequests, 10);
  assert.equal(local.config.usageLimits.blockRequests, 20);

  const overridden = loadConfiguration({
    here: dir,
    env: {
      ...isolatedPlatformEnv(dir),
      DSH_SUBAGENT_ROOT: '../env-data',
      DSH_SUBAGENT_PROVIDERS_DIR: '../env-providers',
      DSH_SUBAGENT_PORT: '43210',
      DSH_SUBAGENT_NODE: 'node',
      WAXWING_RESEARCH_ROOT: '../env-research',
    },
  });
  assert.equal(overridden.config.root, path.resolve(dir, '../env-data'));
  assert.equal(overridden.config.providersDir, path.resolve(dir, '../env-providers'));
  assert.equal(overridden.config.port, 43210);
  assert.equal(overridden.config.node, 'node');
  assert.equal(overridden.config.researchRoot, path.resolve(dir, '../env-research'));
});

test('configuration rejects invalid ports and malformed JSON', t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({port: 43187}));
  assert.throws(
    () => loadConfiguration({here: dir, env: {DSH_SUBAGENT_PORT: '0'}}),
    /Port must be an integer between 1 and 65535/,
  );
  assert.throws(
    () => loadConfiguration({here: dir, env: {DSH_SUBAGENT_PORT: 'not-a-port'}}),
    /Port must be an integer between 1 and 65535/,
  );

  fs.writeFileSync(path.join(dir, 'config.json'), '{broken');
  assert.throws(
    () => loadConfiguration({here: dir, env: {}}),
    /Invalid configuration/,
  );
});

test('the local config location matches the table shared with the Rust desktop', t => {
  for (const item of LOCAL_CONFIG_FIXTURE.cases) {
    const base = fixture(t);
    const configDir = path.join(base, 'config');
    const homeDir = path.join(base, 'home');
    fs.mkdirSync(configDir, {recursive: true});
    fs.writeFileSync(path.join(configDir, 'config.json'), '{}\n');
    if (item.homeFile) {
      fs.mkdirSync(homeDir, {recursive: true});
      fs.writeFileSync(path.join(homeDir, 'config.local.json'), '{}\n');
    }
    if (item.legacyFile) {
      fs.writeFileSync(path.join(configDir, 'config.local.json'), '{}\n');
    }

    const vars = {base, home: homeDir, config: configDir, cwd: process.cwd()};
    const env = {WAXWING_CONFIG: path.join(configDir, 'config.json')};
    for (const [key, value] of Object.entries(item.env)) env[key] = fill(value, vars);

    const loaded = loadConfiguration({here: configDir, env});
    assert.equal(loaded.localConfigPath, path.resolve(fill(item.expect.path, vars)), item.name);
    assert.equal(loaded.localConfigSource, item.expect.source, item.name);
  }
});

test('a local file in the per-user directory anchors relative paths there', t => {
  const dir = fixture(t);
  const configDir = path.join(dir, 'config');
  const homeDir = platformHome(dir);
  fs.mkdirSync(configDir, {recursive: true});
  fs.mkdirSync(homeDir, {recursive: true});
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({root: './public-data'}));
  fs.writeFileSync(path.join(homeDir, 'config.local.json'), JSON.stringify({
    root: './local-data',
    providersDir: './local-providers',
    node: './bin/node',
  }));

  const loaded = loadConfiguration({here: configDir, env: isolatedPlatformEnv(dir)});

  // The file's own location comes from the platform directory, never from
  // `root`; only the data root follows that value.
  assert.equal(loaded.localConfigPath, path.join(homeDir, 'config.local.json'));
  assert.equal(loaded.localConfigSource, 'home');
  assert.equal(loaded.config.root, path.join(homeDir, 'local-data'));
  assert.equal(loaded.config.researchRoot, path.join(homeDir, 'local-data-research'));
  assert.equal(loaded.config.providersDir, path.join(homeDir, 'local-providers'));
  assert.equal(loaded.config.node, path.join(homeDir, 'bin', 'node'));
});

test('a legacy local file keeps config.json as its relative base', t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({root: './public-data'}));
  fs.writeFileSync(path.join(dir, 'config.local.json'), JSON.stringify({
    root: './legacy-data',
    node: './bin/node',
  }));

  const loaded = loadConfiguration({here: dir, env: isolatedPlatformEnv(dir)});

  assert.equal(loaded.localConfigSource, 'legacy');
  assert.equal(loaded.localConfigPath, path.join(dir, 'config.local.json'));
  assert.equal(loaded.config.root, path.join(dir, 'legacy-data'));
  assert.equal(loaded.config.node, path.join(dir, 'bin', 'node'));
});

test('the per-user file replaces the legacy file instead of merging with it', t => {
  const dir = fixture(t);
  const homeDir = platformHome(dir);
  fs.mkdirSync(homeDir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    defaultProvider: 'public',
    usageLimits: {enabled: false, warnRequests: 10},
  }));
  fs.writeFileSync(path.join(dir, 'config.local.json'), JSON.stringify({
    defaultProvider: 'legacy',
    root: './legacy-data',
    usageLimits: {enabled: true},
  }));
  fs.writeFileSync(path.join(homeDir, 'config.local.json'), JSON.stringify({
    defaultProvider: 'home',
    usageLimits: {warnRequests: 42},
  }));

  const loaded = loadConfiguration({here: dir, env: isolatedPlatformEnv(dir)});

  assert.equal(loaded.localConfigSource, 'home');
  assert.equal(loaded.config.defaultProvider, 'home');
  assert.equal(loaded.config.root, homeDir, 'the legacy root is not read');
  assert.deepEqual(loaded.config.usageLimits, {enabled: false, warnRequests: 42});
});

test('an explicit local file is the only local layer', t => {
  const dir = fixture(t);
  const homeDir = path.join(dir, 'home');
  const explicit = path.join(dir, 'custom', 'local.json');
  fs.mkdirSync(homeDir, {recursive: true});
  fs.mkdirSync(path.dirname(explicit), {recursive: true});
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({defaultProvider: 'public'}));
  fs.writeFileSync(path.join(dir, 'config.local.json'), JSON.stringify({defaultProvider: 'legacy'}));
  fs.writeFileSync(path.join(homeDir, 'config.local.json'), JSON.stringify({defaultProvider: 'home'}));
  fs.writeFileSync(explicit, JSON.stringify({defaultProvider: 'explicit'}));

  const loaded = loadConfiguration({
    here: dir,
    env: {
      ...isolatedPlatformEnv(dir),
      WAXWING_HOME: homeDir,
      WAXWING_LOCAL_CONFIG: explicit,
    },
  });

  assert.equal(loaded.localConfigSource, 'env');
  assert.equal(loaded.localConfigPath, explicit);
  assert.equal(loaded.config.defaultProvider, 'explicit');
});

test('legacy migration copies task data once and retains the old directory', t => {
  const dir = fixture(t);
  const legacyRoot = path.join(dir, 'legacy');
  const targetRoot = path.join(dir, 'Waxwing');
  fs.mkdirSync(path.join(legacyRoot, 'runs', 'task-0123456789ab'), {recursive: true});
  fs.mkdirSync(path.join(legacyRoot, 'reports'), {recursive: true});
  fs.mkdirSync(path.join(legacyRoot, 'providers'), {recursive: true});
  fs.writeFileSync(path.join(legacyRoot, 'runs', 'task-0123456789ab', 'task.json'), '{"id":"task-0123456789ab"}\n');
  fs.writeFileSync(path.join(legacyRoot, 'reports', 'task-0123456789ab.md'), '# old report\n');
  fs.writeFileSync(path.join(legacyRoot, 'providers', 'local.json'), '{"name":"local"}\n');

  migrateLegacyData({targetRoot, legacyRoot, rootExplicit: false});
  migrateLegacyData({targetRoot, legacyRoot, rootExplicit: false});

  assert.equal(
    fs.readFileSync(path.join(targetRoot, 'runs', 'task-0123456789ab', 'task.json'), 'utf8'),
    '{"id":"task-0123456789ab"}\n',
  );
  assert.equal(fs.readFileSync(path.join(targetRoot, 'reports', 'task-0123456789ab.md'), 'utf8'), '# old report\n');
  assert.equal(fs.existsSync(path.join(legacyRoot, 'runs', 'task-0123456789ab', 'task.json')), true);
  const marker = JSON.parse(fs.readFileSync(path.join(targetRoot, '.migration.json'), 'utf8'));
  assert.equal(marker.policy, 'copy-only-legacy-data-retained');
  assert.deepEqual(marker.copied.sort(), ['providers', 'reports', 'runs']);
});

test('legacy migration refuses a non-empty target without changing either side', t => {
  const dir = fixture(t);
  const legacyRoot = path.join(dir, 'legacy');
  const targetRoot = path.join(dir, 'Waxwing');
  fs.mkdirSync(path.join(legacyRoot, 'runs'), {recursive: true});
  fs.writeFileSync(path.join(legacyRoot, 'runs', 'old.json'), 'old\n');
  fs.mkdirSync(targetRoot, {recursive: true});
  fs.writeFileSync(path.join(targetRoot, 'keep.txt'), 'keep\n');

  assert.throws(
    () => migrateLegacyData({targetRoot, legacyRoot, rootExplicit: false}),
    /not empty.*old data was retained/i,
  );
  assert.equal(fs.readFileSync(path.join(targetRoot, 'keep.txt'), 'utf8'), 'keep\n');
  assert.equal(fs.readFileSync(path.join(legacyRoot, 'runs', 'old.json'), 'utf8'), 'old\n');
  assert.equal(fs.existsSync(path.join(targetRoot, 'runs')), false);
});
