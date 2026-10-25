// Portable configuration layering and path resolution.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadConfiguration} from '../config.mjs';
import {migrateLegacyData} from '../common.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-subagent-config-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
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

  const local = loadConfiguration({here: dir, env: {}});
  assert.equal(local.config.root, path.resolve(dir, 'local-data'));
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
      DSH_SUBAGENT_ROOT: '../env-data',
      DSH_SUBAGENT_PROVIDERS_DIR: '../env-providers',
      DSH_SUBAGENT_PORT: '43210',
      DSH_SUBAGENT_NODE: 'node',
    },
  });
  assert.equal(overridden.config.root, path.resolve(dir, '../env-data'));
  assert.equal(overridden.config.providersDir, path.resolve(dir, '../env-providers'));
  assert.equal(overridden.config.port, 43210);
  assert.equal(overridden.config.node, 'node');
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
