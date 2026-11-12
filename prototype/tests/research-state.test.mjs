import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVE_TASK,
  aggregateBatchStatus,
  countByShardStatus,
  isActiveBatch,
  isTerminalBatch,
  shardCapturePatch,
  shardTransition,
  TERMINAL_TASK,
} from '../../src/research/state.mjs';
import {ACTIVE_TASK_STATUSES, TERMINAL_TASK_STATUSES} from '../../src/tasks/lifecycle.mjs';

const shard = status => ({status, taskId: 'task-0123456789ab'});

test('batch status preserves completed work when cancellation wins', () => {
  assert.equal(aggregateBatchStatus({
    cancelRequested: true,
    shards: [shard('completed'), shard('running')],
  }), 'cancelling');
  assert.equal(aggregateBatchStatus({
    cancelRequested: true,
    shards: [shard('completed'), shard('cancelled')],
  }), 'partial');
  assert.equal(aggregateBatchStatus({
    cancelRequested: true,
    shards: [shard('cancelled'), shard('failed')],
  }), 'cancelled');
  assert.equal(aggregateBatchStatus({
    cancelRequested: true,
    shards: [shard('cancelled'), shard('running')],
  }), 'cancelling');
});

test('finalizing is visible before a batch becomes terminal', () => {
  assert.equal(aggregateBatchStatus({
    cancelRequested: false,
    shards: [{...shard('completed'), finalizing: true}],
  }), 'finalizing');
  assert.equal(aggregateBatchStatus({
    cancelRequested: false,
    shards: [shard('completed'), shard('completed')],
  }), 'completed');
  assert.equal(aggregateBatchStatus({
    cancelRequested: false,
    shards: [shard('completed'), shard('failed')],
  }), 'partial');
  assert.equal(aggregateBatchStatus({
    cancelRequested: false,
    shards: [shard('failed'), shard('cancelled')],
  }), 'failed');
});

test('shard transitions capture terminal evidence exactly once and request finalization', () => {
  const capture = shardTransition({status: 'running', taskStatus: 'running'}, {
    status: 'awaiting_review',
  });
  assert.deepEqual(capture, {
    dirty: true,
    patch: {taskStatus: 'awaiting_review', finalizing: true},
    capture: true,
    finalize: true,
    terminal: true,
  });
  const finalize = shardTransition({
    status: 'completed',
    taskStatus: 'awaiting_review',
    resultCaptured: true,
  }, {status: 'awaiting_review'});
  assert.equal(finalize.capture, false);
  assert.equal(finalize.finalize, true);
  const closed = shardTransition({
    status: 'completed',
    taskStatus: 'closed',
    resultCaptured: true,
    runtimeReleased: true,
  }, {status: 'closed'});
  assert.equal(closed.finalize, false);
  assert.equal(closed.dirty, false);
});

test('missing records, active tasks, and terminal sets are explicit', () => {
  const missing = shardTransition({status: 'running', taskId: 'task-missing'}, null);
  assert.equal(missing.dirty, true);
  assert.deepEqual(missing.patch, {
    status: 'failed',
    error: 'Task record is missing: task-missing',
  });
  const active = shardTransition({status: 'planned'}, {status: 'running'});
  assert.deepEqual(active.patch, {taskStatus: 'running', status: 'running'});
  const cancelledStatus = shardTransition({status: 'cancelled', taskStatus: 'running'}, {status: 'running'});
  assert.deepEqual(cancelledStatus, {
    dirty: false,
    patch: {},
    capture: false,
    finalize: false,
    terminal: false,
  });
  assert.equal(isActiveBatch('running'), true);
  assert.equal(isActiveBatch('finalizing'), true);
  assert.equal(isTerminalBatch('partial'), true);
  assert.deepEqual(countByShardStatus([shard('completed'), shard('failed')]), {
    total: 2,
    planned: 0,
    running: 0,
    completed: 1,
    failed: 1,
    cancelled: 0,
  });
});

test('a closed task is terminal without a second capture or finalization', () => {
  const transitioned = shardTransition({
    status: 'completed',
    taskId: 'task-0123456789ab',
    taskStatus: 'awaiting_review',
    resultCaptured: true,
    runtimeReleased: true,
  }, {status: 'closed'});
  assert.deepEqual(transitioned, {
    dirty: true,
    patch: {taskStatus: 'closed'},
    capture: false,
    finalize: false,
    terminal: true,
  });
});

const CAPTURE_CASES = [
  {
    name: 'a review-ready finish is completed evidence',
    view: {status: 'awaiting_review', finishReason: 'stop'},
    expect: {status: 'completed', error: null},
  },
  {
    name: 'a closed task keeps the evidence it captured',
    view: {status: 'closed', finishReason: null},
    expect: {status: 'completed', error: null},
  },
  {
    name: 'an error finish reason fails even when the task did not',
    view: {status: 'awaiting_review', finishReason: 'error'},
    expect: {status: 'failed', error: 'Research shard failed without an error message'},
  },
  {
    name: 'a failed task keeps its own error text',
    view: {status: 'failed', error: 'provider down'},
    expect: {status: 'failed', error: 'provider down'},
  },
  {
    name: 'a cancelled task keeps its own error text',
    view: {status: 'cancelled', error: 'stopped by operator'},
    expect: {status: 'cancelled', error: 'stopped by operator'},
  },
  {
    name: 'a cancelled task without an error gets a stable default',
    view: {status: 'cancelled'},
    expect: {status: 'cancelled', error: 'Research shard cancelled'},
  },
  {
    name: 'a missing view still yields a completed patch',
    view: null,
    expect: {status: 'completed', error: null},
  },
];

for (const row of CAPTURE_CASES) {
  test(`captured evidence: ${row.name}`, () => {
    assert.deepEqual(shardCapturePatch(row.view), row.expect);
  });
}

test('research and the manager classify task statuses with the same sets', () => {
  assert.equal(ACTIVE_TASK, ACTIVE_TASK_STATUSES);
  assert.equal(TERMINAL_TASK, TERMINAL_TASK_STATUSES);
  assert.deepEqual([...ACTIVE_TASK_STATUSES].sort(), ['created', 'running', 'stopping']);
  assert.deepEqual([...TERMINAL_TASK_STATUSES].sort(),
    ['accepted', 'awaiting_review', 'cancelled', 'closed', 'failed']);
  for (const status of ACTIVE_TASK_STATUSES) {
    assert.equal(TERMINAL_TASK_STATUSES.has(status), false, `${status} must not be terminal`);
  }
});
