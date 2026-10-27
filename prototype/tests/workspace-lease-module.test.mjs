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
