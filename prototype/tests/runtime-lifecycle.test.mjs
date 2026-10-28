import test from 'node:test';
import assert from 'node:assert/strict';
import {RuntimeLifecycle} from '../../src/runtime/lifecycle.mjs';

const NOW = '2026-10-28T10:00:00.000Z';
const task = () => ({
  id: 'task-0123456789ab',
  status: 'stopping',
  eventSequence: 17,
  rounds: [{number: 1, roundId: 'round-1', result: {text: 'keep', finishReason: 'completed'}}],
  workspaceLease: {mode: 'worktree', status: 'active'},
});
const runtime = () => ({
  taskId: 'task-0123456789ab',
  pid: 4901,
  ownerMarker: 'owner',
  phase: 'running',
  roundId: 'round-1',
});

function lifecycle(terminate = () => {}) {
  return new RuntimeLifecycle({terminate, now: () => NOW});
}

test('a verified residual runtime is terminated and retains the workspace', () => {
  let terminated = null;
  let receivedIdentity = null;
  const result = lifecycle((record, options) => {
    terminated = record;
    receivedIdentity = options?.identity ?? null;
    return {terminated: true};
  }).recover({
    task: task(),
    runtime: runtime(),
    identity: {verified: true, alive: true, reason: 'identity matches'},
  });

  assert.equal(terminated.pid, 4901);
  assert.equal(receivedIdentity.verified, true);
  assert.equal(result.decision, 'terminated');
  assert.equal(result.runtime.phase, 'recovered-terminated');
  assert.equal(result.runtime.manualActionRequired, false);
  assert.equal(result.task.status, 'failed');
  assert.equal(result.task.workspaceLease.status, 'retained');
  assert.match(result.task.error, /no longer reusable/);
  assert.equal(result.task.eventSequence, 17);
  assert.deepEqual(result.task.rounds, task().rounds);
});

test('a live but unverified PID keeps the lock and requires manual handling', () => {
  const result = lifecycle(() => {
    throw new Error('must not terminate an unverified process');
  }).recover({
    task: task(),
    runtime: runtime(),
    identity: {verified: false, alive: true, reason: 'owner marker mismatch'},
  });

  assert.equal(result.decision, 'manual');
  assert.equal(result.runtime.phase, 'orphaned-unverified');
  assert.equal(result.runtime.manualActionRequired, true);
  assert.equal(result.task.workspaceLease.status, 'locked-unverified');
  assert.match(result.task.error, /workspace lock retained/);
  assert.equal(result.task.eventSequence, 17);
});

test('a disappeared process becomes a recoverable failed record', () => {
  const result = lifecycle(() => {
    throw new Error('no process to terminate');
  }).recover({
    task: task(),
    runtime: runtime(),
    identity: {verified: false, alive: false, reason: 'recorded PID is not running'},
  });

  assert.equal(result.decision, 'exited');
  assert.equal(result.runtime.phase, 'exited');
  assert.equal(result.runtime.manualActionRequired, false);
  assert.equal(result.task.workspaceLease.status, 'retained');
  assert.equal(result.task.rounds[0].result.text, 'keep');
});

test('a termination without a confirmed verdict retains the lock', () => {
  const result = lifecycle(() => ({
    verified: false,
    alive: true,
    terminated: false,
    reason: 'PID was reused before termination',
  })).recover({
    task: task(),
    runtime: runtime(),
    identity: {verified: true, alive: true, reason: 'identity matches'},
  });

  assert.equal(result.decision, 'termination-failed');
  assert.equal(result.runtime.phase, 'recovery-failed');
  assert.equal(result.runtime.manualActionRequired, true);
  assert.equal(result.task.workspaceLease.status, 'locked-unverified');
  assert.match(result.runtime.recovery.reason, /PID was reused before termination/);
});

test('a failed termination retains the lock and records the failure', () => {
  const result = lifecycle(() => {
    throw new Error('access denied');
  }).recover({
    task: task(),
    runtime: runtime(),
    identity: {verified: true, alive: true, reason: 'identity matches'},
  });

  assert.equal(result.decision, 'termination-failed');
  assert.equal(result.runtime.phase, 'recovery-failed');
  assert.equal(result.runtime.manualActionRequired, true);
  assert.match(result.runtime.recovery.reason, /could not be terminated: access denied/);
  assert.equal(result.task.workspaceLease.status, 'locked-unverified');
});

test('an unconfirmed close keeps stopping, the handle, and the workspace lease', () => {
  const stopping = {...task(), status: 'stopping'};
  const result = lifecycle().exit({task: stopping, exitConfirmed: false});

  assert.equal(result.decision, 'exit-unconfirmed');
  assert.equal(result.releaseHandle, false);
  assert.equal(result.workspaceRetained, true);
  assert.equal(result.task.status, 'stopping');
  assert.match(result.error, /could not confirm worker exit/);
});

test('a confirmed close forgets the handle and maps a close error to failed', () => {
  const stopped = lifecycle().exit({task: task(), exitConfirmed: true});
  assert.equal(stopped.decision, 'exited');
  assert.equal(stopped.releaseHandle, true);

  const failed = lifecycle().exit({
    task: task(),
    exitConfirmed: true,
    closeError: 'close request failed: pipe broke',
  });
  assert.equal(failed.decision, 'cleanup-failed');
  assert.equal(failed.task.status, 'failed');
  assert.equal(failed.task.updatedAt, NOW);
  assert.match(failed.error, /runtime cleanup failed: close request failed/);
  assert.equal(failed.releaseHandle, true);
  assert.equal(failed.workspaceRetained, true);
});

test('records without a lease and invalid inputs are handled explicitly', () => {
  const legacy = task();
  delete legacy.workspaceLease;
  const result = lifecycle().recover({
    task: legacy,
    runtime: runtime(),
    identity: {verified: false, alive: false, reason: 'not running'},
  });
  assert.equal(result.workspaceStatus, null);
  assert.equal(result.task.workspaceLease, undefined);
  assert.throws(() => lifecycle().recover({runtime: runtime(), identity: {}}), /task record/);
  assert.throws(() => lifecycle().recover({task: task(), identity: {}}), /runtime record/);
  assert.throws(() => lifecycle().recover({task: task(), runtime: runtime()}), /identity/);
});

test('a terminal record is left unchanged on a repeated restore', () => {
  const terminal = {...task(), status: 'failed'};
  const result = lifecycle(() => {
    throw new Error('must not terminate a terminal record');
  }).recover({
    task: terminal,
    runtime: runtime(),
    identity: {verified: true, alive: true, reason: 'identity matches'},
  });
  assert.equal(result.decision, 'not-recoverable');
  assert.equal(result.task, terminal);
  assert.equal(result.task.eventSequence, 17);
  assert.equal(result.task.workspaceLease.status, 'active');
});

