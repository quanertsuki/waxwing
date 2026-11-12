// Manager assembly: one explicit context per manager, injectable platform
// dependencies, and no shared process-global configuration.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createManager} from '../manager.mjs';
import {createRuntimeContext, PROTOTYPE_DIR, runtimeContext} from '../../src/config/context.mjs';
import {createFakeWorker} from './fake-worker.mjs';
import {TEST_LOCAL_CONFIG, TEST_PROVIDERS} from './isolate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = path.join(HERE, '.tmp', `assembly-${process.pid}`);
fs.rmSync(BASE, {recursive: true, force: true});
fs.mkdirSync(BASE, {recursive: true});

/** One isolated context whose data root and providers never touch the suite. */
function isolatedContext(name) {
  const home = path.join(BASE, name);
  fs.mkdirSync(home, {recursive: true});
  return createRuntimeContext({
    here: PROTOTYPE_DIR,
    env: {
      WAXWING_HOME: home,
      WAXWING_PROVIDERS_DIR: TEST_PROVIDERS,
      WAXWING_LOCAL_CONFIG: TEST_LOCAL_CONFIG,
      WAXWING_PORT: '43199',
    },
  });
}

const fakeFork = () => createFakeWorker({pid: 4301});
let workspaceCounter = 0;
function newWorkspace() {
  const directory = path.join(BASE, `ws-${++workspaceCounter}`);
  fs.mkdirSync(directory, {recursive: true});
  return directory;
}

test('two managers with different data roots do not share tasks or files', async () => {
  const first = isolatedContext('first');
  const second = isolatedContext('second');
  const firstManager = createManager({context: first, forkWorker: fakeFork});
  const secondManager = createManager({context: second, forkWorker: fakeFork});
  try {
    const created = await firstManager.action('create', {
      workspace: newWorkspace(),
      prompt: 'work',
      plan: 'p',
      criteria: 'c',
      provider: 'deepseek-flash',
    });

    assert.equal((await firstManager.action('list')).length, 1);
    assert.deepEqual(await secondManager.action('list'), []);
    assert.ok(created.dataDirectory.startsWith(path.join(first.root, 'runs')));
    assert.deepEqual(fs.readdirSync(second.runsDir), []);
    assert.ok(fs.existsSync(path.join(created.dataDirectory, 'task.json')));
  } finally {
    await firstManager.shutdown();
    await secondManager.shutdown();
  }
});

test('an injected clock, filesystem, and git implementation are the ones used', async () => {
  const context = isolatedContext('injected');
  const fixed = new Date('2026-01-02T03:04:05.000Z');
  const mkdirs = [];
  const injectedFs = new Proxy(fs, {
    get(target, key) {
      if (key === 'mkdirSync') {
        return (...args) => {
          mkdirs.push(path.resolve(args[0]));
          return target.mkdirSync(...args);
        };
      }
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const manager = createManager({
    context,
    forkWorker: fakeFork,
    clock: {now: () => fixed},
    fs: injectedFs,
  });
  const gitManager = createManager({
    context,
    forkWorker: fakeFork,
    git: {
      inspectGitWorkspace: workspace => ({
        isGit: true,
        workspace,
        repoRoot: workspace,
        baseCommit: 'a'.repeat(40),
        dirty: false,
        status: '',
        workspaceRelative: '',
      }),
      createWorktree: () => { throw new Error('injected git worktree'); },
    },
  });
  try {
    const created = await manager.action('create', {
      workspace: newWorkspace(),
      prompt: 'work',
      plan: 'p',
      criteria: 'c',
      provider: 'deepseek-flash',
    });
    const status = await manager.action('status', {id: created.id});
    assert.equal(status.createdAt, fixed.toISOString());
    assert.ok(mkdirs.some(directory => directory.startsWith(path.join(context.root, 'runs'))));

    await assert.rejects(
      () => gitManager.action('create', {
        workspace: newWorkspace(),
        prompt: 'worktree',
        plan: 'p',
        criteria: 'c',
        provider: 'deepseek-flash',
        workspaceMode: 'worktree',
      }),
      /injected git worktree/,
    );
  } finally {
    await manager.shutdown();
    await gitManager.shutdown();
  }
});

test('the default context configuration is frozen and imports do not resolve it eagerly', () => {
  assert.ok(Object.isFrozen(runtimeContext().config));
  assert.ok(Object.isFrozen(runtimeContext()));
});
