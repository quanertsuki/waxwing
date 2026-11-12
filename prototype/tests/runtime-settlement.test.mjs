// Every runtime fact has exactly one projection. This table is the contract:
// the same inputs must yield a status the lifecycle table permits, one event
// kind, a lease conclusion, and one handle decision.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RuntimeSettlement,
  MANUAL_RETAINED,
  NORMAL_RETAINED,
} from '../../src/runtime/settlement.mjs';
import {TaskLifecycle} from '../../src/tasks/lifecycle.mjs';

const NOW = '2026-10-29T00:00:00.000Z';

function settlement(overrides = {}) {
  return new RuntimeSettlement({now: () => NOW, ...overrides});
}

function task(status = 'running', extra = {}) {
  return {
    id: 'task-0123456789ab',
    status,
    eventSequence: 17,
    rounds: [{number: 1, roundId: 'round-1', prompt: 'work', maxTokens: 1024}],
    provider: {name: 'first', type: 'dsh-sdk', model: 'model'},
    workspaceLease: {mode: 'worktree', status: 'active'},
    ...extra,
  };
}

function runtimeRecord() {
  return {
    taskId: 'task-0123456789ab',
    pid: 4901,
    ownerMarker: 'owner',
    phase: 'running',
    roundId: 'round-1',
  };
}

// Each fact names how to produce a projection and which statuses it may move.
const FAILURE_FACTS = [
  {
    name: 'a startup failure',
    event: 'start_failed',
    outcome: (service, value) => service.startFailed({
      task: value,
      error: 'fork failed',
      message: 'Task task-0123456789ab failed to start: fork failed',
      runtimeUnconfirmed: true,
    }),
    moved: {running: 'failed', stopping: 'failed', failed: 'failed'},
  },
  {
    name: 'a failed Provider fallback',
    event: 'provider_fallback_failed',
    outcome: (service, value) => service.fallbackFailed({
      task: value,
      providerName: 'fallback',
      message: 'Fallback to fallback also failed: quota',
    }),
    moved: {running: 'failed', stopping: 'failed', failed: 'failed'},
  },
  {
    name: 'a failed stop',
    event: 'round_stop_failed',
    outcome: (service, value) => service.stopFailed({
      task: value,
      timeoutMs: 2000,
      message: 'Task task-0123456789ab timed out, but stopping it failed: exit pending',
    }),
    moved: {running: 'failed', stopping: 'failed', failed: 'failed'},
  },
  {
    name: 'a release without a terminal message',
    event: 'round_protocol_error',
    outcome: (service, value) => service.missingTerminal({task: value, message: {roundId: 'round-1'}}),
    moved: {running: 'failed', stopping: 'failed', failed: 'failed'},
  },
  {
    name: 'a busy worker',
    event: 'worker_busy',
    outcome: (service, value) => service.workerBusy({task: value, message: {roundId: 'round-1'}}),
    moved: {running: 'failed', stopping: 'failed', failed: 'failed'},
  },
  {
    name: 'an ACK timeout',
    event: 'round_ack_timeout',
    outcome: (service, value) => service.ackTimeout({task: value, roundId: 'round-1', timeoutMs: 2000}),
    moved: {running: 'failed', stopping: 'failed', failed: 'failed'},
  },
];

const ACTION_BY_STATUS = {running: 'fail', stopping: 'fail_stop', failed: null};

test('failure facts move exactly the statuses the lifecycle table allows', () => {
  const service = settlement();
  for (const fact of FAILURE_FACTS) {
    for (const [status, expectedStatus] of Object.entries(fact.moved)) {
      const source = task(status);
      const outcome = fact.outcome(service, source);

      assert.equal(outcome.task.status, expectedStatus, `${fact.name} from ${status}`);
      assert.equal(outcome.action, ACTION_BY_STATUS[status], `${fact.name} from ${status}`);
      assert.equal(outcome.event.kind, fact.event, `${fact.name} from ${status}`);
      assert.equal(typeof outcome.error, 'string', `${fact.name} from ${status}`);
      assert.equal(outcome.task.error, outcome.error);

      if (outcome.action) {
        assert.equal(TaskLifecycle.can(source, outcome.action), true, `${fact.name} from ${status}`);
        assert.equal(outcome.task.eventSequence, source.eventSequence);
        assert.deepEqual(outcome.task.rounds, source.rounds);
      } else {
        assert.equal(outcome.task.updatedAt, NOW, 'a repeated failure still updates updatedAt');
      }
    }
  }
});

test('a failure beyond running, stopping, and failed is a caller-order bug', () => {
  const service = settlement();
  for (const status of ['created', 'awaiting_review', 'accepted', 'cancelled', 'closed']) {
    const fact = FAILURE_FACTS[0];
    assert.throws(
      () => fact.outcome(service, task(status)),
      /Cannot fail task in/,
      `startFailed from ${status}`,
    );
    assert.throws(
      () => service.fallbackFailed({task: task(status), providerName: 'fallback', message: 'no'}),
      /Cannot fail task in/,
      `fallbackFailed from ${status}`,
    );
  }
});

test('process error and exit fail a running round and leave expected exits alone', () => {
  const service = settlement();
  const running = service.processError({task: task('running'), error: new Error('spawn error')});
  assert.equal(running.task.status, 'failed');
  assert.equal(running.action, 'fail');
  assert.equal(running.event.kind, 'runtime_error');
  assert.match(running.task.error, /worker error: spawn error/);

  const exited = service.processExited({task: task('running'), code: 3});
  assert.equal(exited.task.status, 'failed');
  assert.equal(exited.event.kind, 'runtime_exit');
  assert.equal(exited.event.exitCode, 3);
  assert.match(exited.task.error, /worker exited \(3\)/);

  const repeated = service.processExited({task: task('failed'), code: 0});
  assert.equal(repeated.task.status, 'failed');
  assert.equal(repeated.action, null);
  assert.equal(repeated.event.kind, 'runtime_exit');

  for (const status of ['stopping', 'awaiting_review', 'accepted']) {
    const source = task(status);
    const outcome = service.processExited({task: source, code: 0});
    assert.equal(outcome.task, source, `an expected exit leaves ${status} unchanged`);
    assert.equal(outcome.action, null);
    assert.equal(outcome.event, null);
  }
});

test('a close without a confirmed exit keeps the handle and the lease', () => {
  const source = task('stopping');
  const outcome = settlement().close({task: source, exitConfirmed: false});
  assert.equal(outcome.task, source);
  assert.equal(outcome.action, null);
  assert.equal(outcome.releaseHandle, false);
  assert.deepEqual(outcome.lease, {status: 'active'});
  assert.match(outcome.error, /could not confirm worker exit/);
});

test('a cleanup failure after a confirmed exit becomes failed with fail_stop', () => {
  const source = task('stopping');
  const outcome = settlement().close({
    task: source,
    exitConfirmed: true,
    closeError: 'close request failed: pipe broke',
  });
  assert.equal(outcome.task.status, 'failed');
  assert.equal(outcome.action, 'fail_stop');
  assert.equal(outcome.task.updatedAt, NOW);
  assert.match(outcome.task.error, /runtime cleanup failed: close request failed/);
  assert.equal(outcome.releaseHandle, true);
  assert.deepEqual(outcome.lease, {status: 'active'});
  assert.equal(source.status, 'stopping', 'the source record must stay untouched');
});

test('a cleanup failure from a non-stopping status is rejected', () => {
  assert.throws(
    () => settlement().close({task: task('awaiting_review'), exitConfirmed: true, closeError: 'x'}),
    /Cannot fail task in/,
  );
});

test('a confirmed clean exit releases the handle and retains the lease', () => {
  const source = task('stopping');
  const outcome = settlement().close({task: source, exitConfirmed: true});
  assert.equal(outcome.task, source);
  assert.equal(outcome.action, null);
  assert.equal(outcome.releaseHandle, true);
  assert.equal(outcome.error, null);
  assert.deepEqual(outcome.lease, {status: 'active'});
  assert.throws(() => settlement().close({exitConfirmed: true}), /task record/);
});

test('terminal results complete or fail the round and never mutate the source', () => {
  const service = settlement();
  const source = task();
  const done = service.terminal({
    task: source,
    message: {kind: 'result', roundId: 'round-1', text: 'done', finishReason: 'completed'},
  });
  assert.equal(done.task.status, 'awaiting_review');
  assert.equal(done.action, 'finish');
  assert.equal(done.task.output, 'done');
  assert.equal(done.task.error, null);
  assert.deepEqual(done.task.rounds[0].result, {
    text: 'done',
    finishReason: 'completed',
    error: null,
  });
  assert.equal(done.event.kind, 'round_finished');
  assert.equal(source.status, 'running');
  assert.equal(source.rounds[0].result, undefined);

  const failed = service.terminal({
    task: task(),
    message: {kind: 'error', roundId: 'round-1', error: 'boom', finishReason: 'error'},
  });
  assert.equal(failed.task.status, 'failed');
  assert.equal(failed.task.error, 'boom');
  assert.equal(failed.event.status, 'failed');
  assert.throws(
    () => service.terminal({task: task('accepted'), message: {kind: 'error', roundId: 'r'}}),
    /Cannot fail task in/,
  );
});

test('first-round fallback hands off only one failed first round', () => {
  const service = settlement({
    fallbackProvider: name => ({name, type: 'dsh-sdk', model: 'fallback'}),
    supportsEffort: () => true,
  });
  const message = {kind: 'error', roundId: 'round-1', error: 'primary failed', finishReason: 'error'};
  const outcome = service.firstRoundFailure({...task(), rounds: [{...task().rounds[0], effort: 'high'}]}, message, 'fallback');
  assert.equal(outcome.task.status, 'failed');
  assert.equal(outcome.task.provider.name, 'fallback');
  assert.equal(outcome.fallback.providerName, 'fallback');
  assert.equal(outcome.fallback.effort, 'high');
  assert.equal(outcome.event.kind, 'provider_fallback');
  assert.equal(outcome.error, null);

  assert.equal(service.firstRoundFailure({...task(), rounds: [{}, {}]}, message, 'fallback'), null);
  assert.equal(service.firstRoundFailure(task(), message, 'first'), null, 'the same provider is not retried');

  const noEffort = settlement({fallbackProvider: name => ({name})});
  assert.equal(noEffort.firstRoundFailure(task(), message, 'fallback').fallback.effort, null);
});

test('a fallback lookup error is reported and never mutates its input', () => {
  const service = settlement({
    fallbackProvider: () => { throw new Error('unknown fallback'); },
  });
  const source = task();
  assert.throws(
    () => service.firstRoundFailure(source, {
      kind: 'error', roundId: 'round-1', error: 'primary failed', finishReason: 'error',
    }, 'fallback'),
    /unknown fallback/,
  );
  assert.equal(source.status, 'running');
  assert.equal(source.rounds[0].result, undefined);
});

// --- restart recovery --------------------------------------------------------

function lifecycle(terminate = () => {}) {
  return settlement({terminate});
}

test('a verified residual runtime is terminated and retains the workspace', () => {
  let terminated = null;
  let receivedIdentity = null;
  const result = lifecycle((record, options) => {
    terminated = record;
    receivedIdentity = options?.identity ?? null;
    return {terminated: true};
  }).recover({
    task: task('stopping'),
    runtime: runtimeRecord(),
    identity: {verified: true, alive: true, reason: 'identity matches'},
  });

  assert.equal(terminated.pid, 4901);
  assert.equal(receivedIdentity.verified, true);
  assert.equal(result.decision, 'terminated');
  assert.equal(result.action, 'fail_stop');
  assert.equal(result.runtime.phase, 'recovered-terminated');
  assert.equal(result.runtime.manualActionRequired, false);
  assert.equal(result.task.status, 'failed');
  assert.equal(result.task.workspaceLease.status, NORMAL_RETAINED);
  assert.deepEqual(result.lease, {status: NORMAL_RETAINED});
  assert.match(result.task.error, /no longer reusable/);
  assert.equal(result.task.eventSequence, 17);
  assert.deepEqual(result.task.rounds, task().rounds);

  const running = lifecycle(() => ({terminated: true})).recover({
    task: task('running'),
    runtime: runtimeRecord(),
    identity: {verified: true, alive: true, reason: 'identity matches'},
  });
  assert.equal(running.action, 'fail');
  assert.equal(running.task.status, 'failed');
});

test('a live but unverified PID keeps the lock and requires manual handling', () => {
  const result = lifecycle(() => {
    throw new Error('must not terminate an unverified process');
  }).recover({
    task: task('stopping'),
    runtime: runtimeRecord(),
    identity: {verified: false, alive: true, reason: 'owner marker mismatch'},
  });

  assert.equal(result.decision, 'manual');
  assert.equal(result.runtime.phase, 'orphaned-unverified');
  assert.equal(result.runtime.manualActionRequired, true);
  assert.equal(result.task.workspaceLease.status, MANUAL_RETAINED);
  assert.match(result.task.error, /workspace lock retained/);
  assert.equal(result.task.eventSequence, 17);
});

test('a disappeared process becomes a recoverable failed record', () => {
  const result = lifecycle(() => {
    throw new Error('no process to terminate');
  }).recover({
    task: task('stopping'),
    runtime: runtimeRecord(),
    identity: {verified: false, alive: false, reason: 'recorded PID is not running'},
  });

  assert.equal(result.decision, 'exited');
  assert.equal(result.runtime.phase, 'exited');
  assert.equal(result.runtime.manualActionRequired, false);
  assert.equal(result.task.workspaceLease.status, NORMAL_RETAINED);
});

test('an unconfirmed termination retains the lock and records why', () => {
  const result = lifecycle(() => ({
    verified: false,
    alive: true,
    terminated: false,
    reason: 'PID was reused before termination',
  })).recover({
    task: task('stopping'),
    runtime: runtimeRecord(),
    identity: {verified: true, alive: true, reason: 'identity matches'},
  });

  assert.equal(result.decision, 'termination-failed');
  assert.equal(result.runtime.phase, 'recovery-failed');
  assert.equal(result.task.workspaceLease.status, MANUAL_RETAINED);
  assert.match(result.runtime.recovery.reason, /PID was reused before termination/);

  const thrown = lifecycle(() => {
    throw new Error('access denied');
  }).recover({
    task: task('stopping'),
    runtime: runtimeRecord(),
    identity: {verified: true, alive: true, reason: 'identity matches'},
  });
  assert.match(thrown.runtime.recovery.reason, /could not be terminated: access denied/);
  assert.equal(thrown.task.workspaceLease.status, MANUAL_RETAINED);
});

test('records without a lease and invalid recovery inputs are handled explicitly', () => {
  const legacy = task('stopping');
  delete legacy.workspaceLease;
  const result = lifecycle().recover({
    task: legacy,
    runtime: runtimeRecord(),
    identity: {verified: false, alive: false, reason: 'not running'},
  });
  assert.equal(result.lease, null);
  assert.equal(result.task.workspaceLease, undefined);

  assert.throws(() => lifecycle().recover({runtime: runtimeRecord(), identity: {}}), /task record/);
  assert.throws(() => lifecycle().recover({task: task('stopping'), identity: {}}), /runtime record/);
  assert.throws(
    () => lifecycle().recover({task: task('stopping'), runtime: runtimeRecord()}),
    /identity/,
  );
});

test('a terminal record is left unchanged on a repeated restore', () => {
  const terminal = task('failed');
  const result = lifecycle(() => {
    throw new Error('must not terminate a terminal record');
  }).recover({
    task: terminal,
    runtime: runtimeRecord(),
    identity: {verified: true, alive: true, reason: 'identity matches'},
  });
  assert.equal(result.decision, 'not-recoverable');
  assert.equal(result.task, terminal);
  assert.equal(result.action, null);
  assert.equal(result.task.eventSequence, 17);
  assert.equal(result.task.workspaceLease.status, 'active');
});
