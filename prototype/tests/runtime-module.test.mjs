// The Runtime module owns one round's lifecycle, so its races are asserted
// here through the module Interface instead of through the manager. Every
// suite below drives `openRound`/`onMessage`/`waitForRelease` directly with a
// fake process handle, which makes a race deterministic instead of a timing
// accident. `runtime-protocol.test.mjs` stays as the end-to-end regression that
// the manager still honours the same contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {
  DEFAULT_EXIT_TIMEOUT_MS,
  Runtime,
  roundTimeouts,
} from '../../src/runtime/module.mjs';
import {DEFAULT_ACK_TIMEOUT_MS, HEARTBEAT_STALE_MS, isRoundId} from '../../src/runtime/protocol.mjs';

const TASK_ID = 'task-0123456789ab';
const FAST = {ackTimeoutMs: 5_000, heartbeatStaleMs: 5_000, heartbeatCheckMs: 1_000, roundTimeoutMs: 0};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const tick = () => new Promise(resolve => setImmediate(resolve));

/** Minimal process handle exposing exactly what the Runtime module listens to. */
function fakeProcess(pid = 4901) {
  const handle = new EventEmitter();
  handle.stdout = new EventEmitter();
  handle.stderr = new EventEmitter();
  handle.pid = pid;
  handle.connected = true;
  handle.exitCode = null;
  handle.signalCode = null;
  handle.sent = [];
  handle.killCalls = 0;
  handle.send = message => { handle.sent.push(message); };
  handle.kill = () => { handle.killCalls += 1; handle.exitCode = 0; setImmediate(() => handle.emit('exit', 0)); };
  handle.exitWith = code => { handle.exitCode = code; handle.emit('exit', code); };
  return handle;
}

function makeTask(id = TASK_ID) {
  return {id, status: 'running', rounds: [], eventSequence: 0};
}

/**
 * A test double for the effects the manager injects: task records, lifecycle
 * transitions, and the round-policy hooks. It records every call so a test can
 * assert which messages the Runtime module accepted and which it discarded.
 */
function harness() {
  const state = {
    events: [], persists: [], saves: 0, untrusted: [], logs: [],
    terminals: [], missing: [], busy: [], handoffs: [],
    ackTimeouts: [], roundTimeouts: [], health: [],
    fallbackOnFailure: null,
  };
  const tasks = new Map();
  const handles = [];
  let nextPid = 4901;
  const runtime = new Runtime({
    spawn: () => {
      const handle = fakeProcess(nextPid++);
      handles.push(handle);
      return handle;
    },
    latest: id => tasks.get(id) ?? null,
    event: ({payload}) => {
      state.events.push(payload);
      if (payload.kind === 'runtime_health') state.health.push(payload);
    },
    save: ({task}) => { state.saves += 1; tasks.set(task.id, task); },
    transition: ({task, action}) => {
      const status = action === 'fail' ? 'failed' : action === 'finish' ? 'awaiting_review' : task.status;
      const next = {...task, status};
      tasks.set(task.id, next);
      return next;
    },
    persist: ({task, rec, extra}) => {
      state.persists.push({taskId: task.id, phase: rec.phase, roundId: rec.roundId, ...(extra ?? {})});
    },
    log: ({chunk}) => state.logs.push(chunk),
    untrusted: ({id, detail}) => state.untrusted.push({id, detail}),
    terminal: ({task, message}) => {
      state.terminals.push({taskId: task.id, roundId: message.roundId, text: message.text});
      const ok = message.kind === 'result' && message.finishReason === 'completed';
      if (!ok && state.fallbackOnFailure) runtime.deferFallback(task.id, state.fallbackOnFailure);
      const next = {...task, status: ok ? 'awaiting_review' : 'failed', output: message.text ?? ''};
      tasks.set(task.id, next);
    },
    terminalMissing: ({task, message}) => {
      state.missing.push({taskId: task.id, roundId: message.roundId});
      tasks.set(task.id, {...task, status: 'failed'});
    },
    workerBusy: ({task, message}) => {
      state.busy.push({taskId: task.id, roundId: message.roundId});
      tasks.set(task.id, {...task, status: 'failed'});
    },
    released: ({fallback}) => state.handoffs.push(fallback ?? null),
    ackTimeout: ({task, roundId, timeoutMs}) => {
      state.ackTimeouts.push({roundId, timeoutMs});
      tasks.set(task.id, {...task, status: 'failed'});
    },
    roundTimeout: ({roundId, timeoutMs}) => state.roundTimeouts.push({roundId, timeoutMs}),
  });
  const addTask = task => { tasks.set(task.id, task); return task; };
  return {runtime, state, handles, addTask, tasks};
}

/** Dispatch one round and take the worker to the acked state. */
function openAcked(runtime, task, options = {}) {
  // The manager moves the live record to `running` before dispatching, and the
  // Runtime re-reads that record through `hooks.latest` on every message. Re-read
  // it here too instead of reusing the snapshot the test captured, otherwise the
  // second round would still be judged against the finished first round's status
  // and its terminal message would be discarded as unacceptable.
  const live = runtime.hooks.latest(task.id) ?? task;
  live.status = 'running';
  const opened = runtime.openRound(live, {prompt: 'work', maxTokens: 1024, timeouts: FAST, ...options});
  const handle = runtime.get(task.id).w;
  handle.emit('message', {kind: 'ready', ownerMarker: runtime.get(task.id).ownerMarker, pid: handle.pid});
  handle.emit('message', {kind: 'ack', roundId: opened.roundId});
  return {...opened, handle};
}

test('roundTimeouts keeps protocol defaults when config omits or corrupts every timer', () => {
  assert.deepEqual(roundTimeouts({}), {
    ackTimeoutMs: DEFAULT_ACK_TIMEOUT_MS,
    heartbeatStaleMs: HEARTBEAT_STALE_MS,
    heartbeatCheckMs: 5_000,
    roundTimeoutMs: 0,
  });
  assert.deepEqual(roundTimeouts({ackTimeoutSeconds: 0, heartbeatStaleMs: -1, heartbeatCheckMs: 'x', roundTimeoutSeconds: NaN}), {
    ackTimeoutMs: DEFAULT_ACK_TIMEOUT_MS,
    heartbeatStaleMs: HEARTBEAT_STALE_MS,
    heartbeatCheckMs: 5_000,
    roundTimeoutMs: 0,
  });
  assert.deepEqual(roundTimeouts({ackTimeoutSeconds: 0.05, heartbeatStaleMs: 40, heartbeatCheckMs: 10, roundTimeoutSeconds: 2}), {
    ackTimeoutMs: 50, heartbeatStaleMs: 40, heartbeatCheckMs: 10, roundTimeoutMs: 2_000,
  });
});

test('every round receives a unique roundId and the gate opens only on released', async () => {
  const {runtime, state, addTask} = harness();
  const task = addTask(makeTask());
  const first = openAcked(runtime, task);
  assert.ok(isRoundId(first.roundId));

  first.handle.emit('message', {kind: 'result', roundId: first.roundId, text: 'first', finishReason: 'completed'});
  assert.equal(state.terminals.length, 1);
  assert.equal(runtime.get(task.id).phase, 'finished', 'a result leaves the round owned by the worker');

  let gateValue;
  const gate = runtime.waitForRelease(task.id).then(value => { gateValue = value; return value; });
  await tick();
  await tick();
  assert.equal(gateValue, undefined, 'a terminal result must never release the round');

  first.handle.emit('message', {kind: 'released', roundId: first.roundId});
  assert.equal(await gate, true);
  assert.equal(runtime.get(task.id).phase, 'idle');
  assert.equal(runtime.get(task.id).roundId, null);

  const second = openAcked(runtime, task);
  assert.notEqual(second.roundId, first.roundId, 'a new dispatch allocates a new roundId');
  assert.equal(runtime.get(task.id).phase, 'running');
});

test('a failed round hands the Provider fallback over only after released', async () => {
  const {runtime, state, addTask} = harness();
  const task = addTask(makeTask());
  state.fallbackOnFailure = {taskId: task.id, prompt: 'retry', maxTokens: 512, providerName: 'magpie'};
  const {roundId, handle} = openAcked(runtime, task);

  handle.emit('message', {kind: 'error', roundId, error: 'first provider failed', finishReason: 'error'});
  assert.equal(state.handoffs.length, 0, 'fallback must not start from the terminal message');
  assert.notEqual(runtime.get(task.id).pendingFallback, null, 'the failure is deferred, not dispatched');

  handle.emit('message', {kind: 'released', roundId});
  assert.deepEqual(state.handoffs, [state.fallbackOnFailure]);
  assert.equal(runtime.get(task.id).pendingFallback, null, 'the handoff clears so it cannot repeat');
});

test('a busy worker rejects the round without dispatch and is reported once', async () => {
  const {runtime, state, addTask} = harness();
  const task = addTask(makeTask());
  task.status = 'running';
  const {roundId, rec} = runtime.openRound(task, {prompt: 'work', maxTokens: 1024, timeouts: FAST});
  const handle = rec.w;
  assert.equal(rec.phase, 'awaiting_ack');

  handle.emit('message', {kind: 'worker_busy', roundId});
  assert.deepEqual(state.busy, [{taskId: task.id, roundId}]);
  assert.equal(rec.rejectedRound, true);
  assert.equal(rec.ackTimer, null, 'the ACK watchdog stops once the round is refused');
  assert.match(runtime.unreworkableReason(task.id), /previous round was not released/i);

  // A refusal for some other round is not this round's business.
  handle.emit('message', {kind: 'worker_busy', roundId: 'round-00000000-0000-4000-8000-000000000000'});
  assert.equal(state.busy.length, 1);

  // An ACK after the refusal must not resurrect the round.
  handle.emit('message', {kind: 'ack', roundId});
  assert.equal(runtime.get(task.id).phase, 'awaiting_ack');
});

test('a duplicate terminal message is discarded by the Runtime, not by the hook', async () => {
  const {runtime, state, addTask} = harness();
  const task = addTask(makeTask());
  const {roundId, handle} = openAcked(runtime, task);

  handle.emit('message', {kind: 'result', roundId, text: 'only result', finishReason: 'completed'});
  handle.emit('message', {kind: 'result', roundId, text: 'duplicate must be ignored', finishReason: 'completed'});
  handle.emit('message', {kind: 'error', roundId, error: 'late error', finishReason: 'error'});

  assert.equal(state.terminals.length, 1);
  assert.equal(state.terminals[0].text, 'only result');
  const reasons = state.events.filter(event => event.kind === 'runtime_message_ignored');
  assert.equal(reasons.length, 2);
  assert.ok(reasons.every(event => event.reason === 'duplicate terminal message'));
  assert.ok(reasons.every(event => event.expectedRoundId === roundId));
});

test('a late message from an older roundId is recorded but never applied', async () => {
  const {runtime, state, addTask} = harness();
  const task = addTask(makeTask());
  const first = openAcked(runtime, task);
  first.handle.emit('message', {kind: 'result', roundId: first.roundId, text: 'round one', finishReason: 'completed'});
  first.handle.emit('message', {kind: 'released', roundId: first.roundId});

  const second = openAcked(runtime, task);
  // Every round-scoped kind from the finished round must be ignored.
  for (const message of [
    {kind: 'ack', roundId: first.roundId},
    {kind: 'heartbeat', roundId: first.roundId},
    {kind: 'event', roundId: first.roundId, notification: {params: {event: {type: 'stale'}}}},
    {kind: 'result', roundId: first.roundId, text: 'stale', finishReason: 'completed'},
    {kind: 'error', roundId: first.roundId, error: 'stale', finishReason: 'error'},
    {kind: 'released', roundId: first.roundId},
  ]) second.handle.emit('message', message);

  assert.equal(state.terminals.length, 1, 'the active round has no terminal message yet');
  assert.equal(runtime.get(task.id).phase, 'running');
  assert.equal(runtime.get(task.id).roundId, second.roundId);
  const ignored = state.events.filter(event => event.kind === 'runtime_message_ignored');
  assert.equal(ignored.length, 6);
  assert.ok(ignored.every(event => event.reason === 'roundId does not match the active round'));
  assert.ok(ignored.every(event => event.expectedRoundId === second.roundId));

  // The active round still completes normally afterwards.
  second.handle.emit('message', {kind: 'result', roundId: second.roundId, text: 'round two', finishReason: 'completed'});
  assert.deepEqual(state.terminals.map(entry => entry.text), ['round one', 'round two']);
});

test('released without a terminal message is a protocol error and releases nothing early', async () => {
  const {runtime, state, addTask} = harness();
  const task = addTask(makeTask());
  const {roundId, handle} = openAcked(runtime, task);

  let gateValue;
  const gate = runtime.waitForRelease(task.id).then(value => { gateValue = value; return value; });
  await tick();
  assert.equal(gateValue, undefined);

  handle.emit('message', {kind: 'released', roundId});
  assert.deepEqual(state.missing, [{taskId: task.id, roundId}]);
  assert.equal(await gate, true, 'the release still opens the gate, so the workspace is not stuck');
  assert.match(runtime.unreworkableReason(task.id), /without a terminal message/i);
  assert.equal(runtime.get(task.id).phase, 'idle');

  // A duplicate release has no matching roundId any more, so it is discarded.
  handle.emit('message', {kind: 'released', roundId});
  assert.equal(state.missing.length, 1);
  const reasons = state.events.filter(event => event.kind === 'runtime_message_ignored').map(event => event.reason);
  assert.deepEqual(reasons, ['roundId does not match the active round']);
});

test('a stalled heartbeat marks health unhealthy while the process is retained', async () => {
  const {runtime, state, addTask} = harness();
  const task = addTask(makeTask());
  const {handle} = openAcked(runtime, task, {
    timeouts: {ackTimeoutMs: 5_000, heartbeatStaleMs: 20, heartbeatCheckMs: 5, roundTimeoutMs: 0},
  });

  await sleep(60);
  const stale = state.health.filter(event => event.detail?.includes('heartbeat stale'));
  assert.ok(stale.length >= 1, 'a stalled heartbeat must be reported');
  assert.equal(state.health.at(-1).health, 'unhealthy');
  assert.match(state.health.at(-1).detail, /process retained/i);

  // Nothing killed the worker and the round still owns its lease.
  assert.equal(handle.killCalls, 0);
  assert.equal(runtime.has(task.id), true);
  assert.equal(runtime.get(task.id).phase, 'running');
  assert.equal(runtime.get(task.id).health, 'unhealthy');

  // One heartbeat restores health and keeps the lease.
  handle.emit('message', {kind: 'heartbeat', roundId: runtime.get(task.id).roundId});
  assert.equal(runtime.get(task.id).health, 'healthy');
  assert.equal(runtime.has(task.id), true);
});

test('an ACK timeout is untrusted, fails the round, and keeps the process alive', async () => {
  const {runtime, state, addTask} = harness();
  const task = addTask(makeTask());
  const opened = runtime.openRound(task, {
    prompt: 'work',
    maxTokens: 1024,
    timeouts: {ackTimeoutMs: 20, heartbeatStaleMs: 5_000, heartbeatCheckMs: 1_000, roundTimeoutMs: 0},
  });
  await sleep(60);

  assert.deepEqual(state.ackTimeouts, [{roundId: opened.roundId, timeoutMs: 20}]);
  assert.equal(runtime.get(task.id).rejectedRound, true);
  assert.match(runtime.unreworkableReason(task.id), /did not acknowledge/i);
  assert.equal(runtime.has(task.id), true, 'an unacknowledged round must not be killed');

  // A late ACK cannot revive a rejected round.
  opened.rec.w.emit('message', {kind: 'ack', roundId: opened.roundId});
  assert.equal(runtime.get(task.id).phase, 'awaiting_ack');
});

test('the round deadline is one timer the Runtime owns and clears on release', async () => {
  const {runtime, state, addTask} = harness();
  const task = addTask(makeTask());
  const {roundId, handle} = openAcked(runtime, task, {
    timeouts: {ackTimeoutMs: 5_000, heartbeatStaleMs: 5_000, heartbeatCheckMs: 1_000, roundTimeoutMs: 20},
  });
  await sleep(60);
  assert.deepEqual(state.roundTimeouts, [{roundId, timeoutMs: 20}]);
  assert.equal(runtime.has(task.id), true, 'the deadline asks for a stop; it never kills by itself');

  handle.emit('message', {kind: 'result', roundId, text: 'done', finishReason: 'completed'});
  handle.emit('message', {kind: 'released', roundId});
  assert.equal(runtime.get(task.id).timer, null, 'releasing clears the round deadline');
  state.roundTimeouts.length = 0;
  await sleep(40);
  assert.deepEqual(state.roundTimeouts, []);
});

test('exit confirmation is reported only for a real exit event', async () => {
  const {runtime, addTask, handles} = harness();
  const task = addTask(makeTask());
  const {handle} = openAcked(runtime, task);

  assert.equal(runtime.hasExited(task.id), false);
  assert.equal(runtime.forget(task.id), false, 'a live handle keeps the workspace lock');
  assert.equal(runtime.has(task.id), true);

  let gateValue;
  const gate = runtime.waitForRelease(task.id).then(value => { gateValue = value; return value; });
  const exited = runtime.waitForExit(task.id, 1_000);
  await tick();
  handle.exitWith(0);
  assert.equal(await exited, true);
  assert.equal(await gate, false, 'an exit before release must not look like a release');
  assert.equal(gateValue, false);
  assert.equal(runtime.has(task.id), false, 'the confirmed exit removes the owned handle');
  assert.equal(runtime.forget(task.id), false);
  assert.equal(handles.length, 1);
});

test('a handle that never exits is reported as unconfirmed inside the timeout', async () => {
  const {runtime, addTask} = harness();
  const task = addTask(makeTask());
  openAcked(runtime, task);
  assert.equal(await runtime.waitForExit(task.id, 20), false);
  assert.equal(runtime.has(task.id), true, 'an unconfirmed exit must keep the lock');
  assert.equal(DEFAULT_EXIT_TIMEOUT_MS > 0, true);
});

test('a synchronous send failure clears every timer and marks the runtime untrusted', () => {
  const {runtime, state, addTask} = harness();
  const task = addTask(makeTask());
  const handle = fakeProcess();
  handle.send = () => { throw new Error('simulated IPC send failure'); };
  runtime.adopt(task, handle, 'owner');
  assert.throws(
    () => runtime.openRound(task, {prompt: 'work', maxTokens: 1, timeouts: FAST}),
    /simulated IPC send failure/,
  );
  const rec = runtime.get(task.id);
  assert.equal(rec.ackTimer, null);
  assert.equal(rec.heartbeatWatch, null);
  assert.equal(rec.timer, null);
  assert.deepEqual(state.untrusted, [{id: task.id, detail: 'IPC send failure'}]);
  assert.equal(runtime.has(task.id), true, 'a handle whose IPC broke still owns the lock');
});

test('a process error fails the round, unblocks the gate, and keeps the handle', () => {
  const {runtime, state, addTask} = harness();
  const task = addTask(makeTask());
  const {handle} = openAcked(runtime, task);
  let gateValue;
  const gate = runtime.waitForRelease(task.id).then(value => { gateValue = value; return value; });

  handle.emit('error', new Error('simulated spawn error'));

  assert.equal(runtime.get(task.id).phase, 'exited');
  assert.deepEqual(state.untrusted, [{id: task.id, detail: 'process error'}]);
  return gate.then(value => {
    assert.equal(value, false);
    assert.equal(gateValue, false);
    assert.equal(runtime.hasExited(task.id), false, 'no exit event has been observed yet');
  });
});

test('beginClose is idempotent so two closes cannot both request shutdown', () => {
  const {runtime, addTask} = harness();
  const task = addTask(makeTask());
  const {handle} = openAcked(runtime, task);
  assert.equal(runtime.isClosing(task.id), false);
  assert.equal(runtime.beginClose(task.id), true);
  assert.equal(runtime.beginClose(task.id), false);
  assert.equal(runtime.isClosing(task.id), true);
  assert.equal(runtime.get(task.id).ackTimer, null, 'closing stops the round watchdogs');

  assert.equal(runtime.sendClose(task.id), null);
  assert.deepEqual(handle.sent.at(-1), {kind: 'close'});

  handle.connected = false;
  assert.equal(runtime.sendClose(task.id), null, 'a disconnected handle is not an error');
  handle.connected = true;
  handle.send = () => { throw new Error('pipe broke'); };
  assert.match(runtime.sendClose(task.id).message, /pipe broke/);
  assert.match(runtime.closeError(task.id), /close request failed: pipe broke/);
});

test('abortClose makes a failed close retryable', () => {
  const {runtime, addTask} = harness();
  const task = addTask(makeTask());
  openAcked(runtime, task);
  assert.equal(runtime.beginClose(task.id), true);
  assert.equal(runtime.abortClose(task.id), true);
  assert.equal(runtime.isClosing(task.id), false);
  assert.equal(runtime.beginClose(task.id), true);
});

test('a close error survives process exit until the handle is forgotten', () => {
  const {runtime, addTask} = harness();
  const task = addTask(makeTask());
  const {handle} = openAcked(runtime, task);
  runtime.beginClose(task.id);
  handle.emit('message', {kind: 'close_error', error: 'harness close failed'});
  handle.exitWith(1);

  assert.equal(runtime.has(task.id), false, 'the process exit removes the owned record');
  assert.equal(runtime.closeError(task.id), 'harness close failed');
  runtime.forget(task.id);
  assert.equal(runtime.closeError(task.id), null);
});