import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {WorkspaceLeaseManager} from '../../src/workspace/lease-manager.mjs';

test('acquire refuses an occupied workspace before materializing anything', () => {
  const manager = new WorkspaceLeaseManager();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'waxwing-lease-occupied-'));
  let planned = 0;
  const plan = manager.plan.bind(manager);
  manager.plan = (...args) => {
    planned += 1;
    return plan(...args);
  };
  try {
    assert.throws(() => manager.acquire({
      workspace,
      taskId: 'task-0123456789ab',
      conflictFor: () => ({id: 'task-aaaaaaaaaaaa', status: 'running', live: true}),
    }), /Workspace is occupied by task task-aaaaaaaaaaaa/);
    assert.equal(planned, 1);
  } finally {
    fs.rmSync(workspace, {recursive: true, force: true});
  }
});

test('release requires a closed, non-live worktree lease and retains the branch', () => {
  const manager = new WorkspaceLeaseManager();
  assert.throws(() => manager.release({task: {status: 'running'}}),
    /Close the task before cleaning/);
  assert.throws(() => manager.release({task: {status: 'closed'}, live: true}),
    /Runtime exit is not confirmed/);
  assert.throws(() => manager.release({
    task: {status: 'closed', workspaceLease: {mode: 'shared'}},
  }), /workspaceLease.mode=worktree/);
});

test('acquire rolls back a partially materialized worktree when materialization fails', () => {
  const manager = new WorkspaceLeaseManager();
  manager.plan = () => ({
    mode: 'worktree',
    sourceWorkspace: '.',
    executionWorkspace: '.',
    lease: {mode: 'worktree', status: 'planned'},
  });
  let rolledBack = null;
  manager.materialize = () => {
    const error = new Error('worktree add failed');
    error.code = 'WORKTREE_ADD_FAILED';
    throw error;
  };
  manager.rollback = lease => {
    rolledBack = lease;
  };
  assert.throws(() => manager.acquire({
    workspace: '.',
    taskId: 'task-0123456789ab',
  }), /worktree add failed/);
  assert.deepEqual(rolledBack, {mode: 'worktree', status: 'planned'});
});

test('acquire compensates a partially materialized worktree exactly once', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waxwing-lease-compensate-'));
  const calls = [];
  const lease = {
    mode: 'worktree',
    status: 'planned',
    repoRoot: root,
    worktreePath: path.join(root, 'worktree'),
    executionWorkspace: path.join(root, 'missing-subdirectory'),
    branch: 'waxwing/task-0123456789ab',
  };
  const manager = new WorkspaceLeaseManager({
    git: {
      createWorktree: () => calls.push('create'),
      rollbackWorktree: value => calls.push(`rollback:${value.status}`),
    },
  });
  manager.plan = () => ({
    mode: 'worktree',
    sourceWorkspace: root,
    executionWorkspace: lease.executionWorkspace,
    lease,
  });
  try {
    assert.throws(() => manager.acquire({
      workspace: root,
      taskId: 'task-0123456789ab',
    }), /WORKTREE_PATH_MISSING/);
    assert.deepEqual(calls, ['create', 'rollback:planned']);
    assert.equal(lease.status, 'rolled_back');
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('rollback is idempotent and never repeats destructive Git work', () => {
  let calls = 0;
  const manager = new WorkspaceLeaseManager({
    git: {rollbackWorktree: () => { calls += 1; }},
  });
  const lease = {mode: 'worktree', status: 'active'};
  manager.rollback(lease);
  manager.rollback(lease);
  assert.equal(calls, 1);
  assert.equal(lease.status, 'rolled_back');
});

test('cleanup refuses a worktree whose runtime identity is unverified', () => {
  const manager = new WorkspaceLeaseManager({
    git: {removeWorktree: () => { throw new Error('must not remove a locked worktree'); }},
  });
  const result = manager.cleanup({
    mode: 'worktree',
    status: 'locked-unverified',
    branch: 'waxwing/task-0123456789ab',
  });
  assert.equal(result.removed, false);
  assert.equal(result.manualActionRequired, true);
  assert.match(result.reason, /manual/i);
});

test('release refuses a residual runtime that requires manual handling', () => {
  const manager = new WorkspaceLeaseManager();
  assert.throws(() => manager.release({
    task: {
      status: 'closed',
      runtime: {manualActionRequired: true},
      workspaceLease: {mode: 'worktree', status: 'locked-unverified'},
    },
  }), /manual/i);
});

test('conflictFor shares overlap and ownership rules for all workspace paths', () => {
  const manager = new WorkspaceLeaseManager();
  const root = path.join(os.tmpdir(), 'waxwing-overlap');
  const tasks = [
    {id: 'task-aaaaaaaaaaaa', status: 'awaiting_review', workspace: path.join(root, 'nested')},
    {id: 'task-bbbbbbbbbbbb', status: 'running', workspace: root},
    {id: 'task-cccccccccccc', status: 'failed', workspace: path.join(root, 'sibling'), runtime: {manualActionRequired: true}},
    {id: 'task-dddddddddddd', status: 'closed', workspace: root},
  ];
  const liveIds = new Set(['task-aaaaaaaaaaaa']);

  assert.equal(manager.conflictFor(path.join(root, 'nested', 'child'), tasks, {
    live: id => liveIds.has(id),
  }).id, 'task-aaaaaaaaaaaa');
  assert.equal(manager.conflictFor(root, tasks, {
    live: () => false,
  }).id, 'task-bbbbbbbbbbbb');
  assert.equal(manager.conflictFor(path.join(root, 'sibling', 'child'), tasks, {
    excludeId: 'task-bbbbbbbbbbbb',
    live: () => false,
  }).id, 'task-cccccccccccc');
  assert.equal(manager.conflictFor(path.join(root, 'sibling', 'child'), tasks, {
    excludeId: 'task-bbbbbbbbbbbb',
    live: () => false,
  }).id, 'task-cccccccccccc');

  if (process.platform === 'win32') {
    assert.equal(manager.conflictFor(root.toUpperCase(), tasks, {
      excludeId: 'task-bbbbbbbbbbbb',
      live: () => false,
    }).id, 'task-cccccccccccc');
  }
  assert.equal(manager.conflictFor(path.join(os.tmpdir(), 'waxwing-outside-root'), tasks, {
    live: () => false,
  }), null);
  assert.equal(manager.conflictFor(root, tasks, {
    excludeId: 'task-bbbbbbbbbbbb',
    live: () => false,
  }).live, false, 'a manual runtime is locked but not reported as live');
});

test('conflictFor marks a live runtime and ignores malformed or completed records', () => {
  const manager = new WorkspaceLeaseManager();
  const workspace = path.join(os.tmpdir(), 'waxwing-conflict-live');
  const tasks = [
    null,
    {id: 'task-aaaaaaaaaaaa', status: 'closed', workspace, runtime: {manualActionRequired: false}},
    {id: 'task-bbbbbbbbbbbb', status: 'awaiting_review', workspace},
  ];
  assert.equal(manager.conflictFor(workspace, tasks, {live: () => false}), null);
  assert.deepEqual(manager.conflictFor(workspace, tasks, {
    live: id => id === 'task-bbbbbbbbbbbb',
  }), {...tasks[2], live: true});
});
