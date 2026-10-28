import test from 'node:test';
import assert from 'node:assert/strict';
import {RuntimeCloseOutcome} from '../../src/runtime/close-outcome.mjs';

const NOW = '2026-10-28T10:00:00.000Z';
const task = () => ({id: 'task-0123456789ab', status: 'awaiting_review', rounds: []});

test('an unconfirmed exit keeps the handle and the workspace lease', () => {
  const projection = new RuntimeCloseOutcome({now: () => NOW}).project({
    task: task(),
    exitConfirmed: false,
  });
  assert.equal(projection.decision, 'exit-unconfirmed');
  assert.equal(projection.releaseHandle, false);
  assert.equal(projection.workspaceRetained, true);
  assert.match(projection.error, /could not confirm worker exit/);
});

test('a cleanup failure becomes a failed task only after exit is confirmed', () => {
  const source = task();
  const projection = new RuntimeCloseOutcome({now: () => NOW}).project({
    task: source,
    exitConfirmed: true,
    closeError: 'close request failed: pipe broke',
  });
  assert.equal(projection.decision, 'cleanup-failed');
  assert.equal(projection.task.status, 'failed');
  assert.equal(projection.task.updatedAt, NOW);
  assert.match(projection.task.error, /runtime cleanup failed: close request failed/);
  assert.equal(projection.releaseHandle, true);
  assert.equal(projection.workspaceRetained, true);
  assert.equal(source.status, 'awaiting_review', 'the source record must stay untouched');
});

test('a confirmed clean exit releases the handle and retains the workspace', () => {
  const source = task();
  const projection = new RuntimeCloseOutcome().project({task: source, exitConfirmed: true});
  assert.equal(projection.decision, 'exited');
  assert.equal(projection.releaseHandle, true);
  assert.equal(projection.workspaceRetained, true);
  assert.equal(projection.error, null);
  assert.equal(projection.task, source);
});

test('a missing task record is rejected explicitly', () => {
  assert.throws(() => new RuntimeCloseOutcome().project({exitConfirmed: true}), /task record/);
});
