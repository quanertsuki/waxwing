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
