import test from 'node:test';
import assert from 'node:assert/strict';
import {RuntimeOutcomeSettlement} from '../../src/runtime/outcome.mjs';

const transitions = {
  finish: task => ({...task, status: 'awaiting_review'}),
  fail: task => ({...task, status: 'failed'}),
};

function settlement(overrides = {}) {
  return new RuntimeOutcomeSettlement({
    transition: (task, action) => transitions[action](task),
    now: () => '2026-10-28T00:00:00.000Z',
    ...overrides,
  });
}

function task(status = 'running') {
  return {
    id: 'task-0123456789ab',
    status,
    rounds: [{number: 1, roundId: 'round-1', prompt: 'work', maxTokens: 1024}],
    provider: {name: 'first', type: 'dsh-sdk', model: 'model'},
  };
}

test('RuntimeOutcomeSettlement completes a successful result', () => {
  const source = task();
  const outcome = settlement().terminal({
    task: source,
    message: {kind: 'result', roundId: 'round-1', text: 'done', finishReason: 'completed'},
  });
  assert.equal(outcome.task.status, 'awaiting_review');
  assert.equal(outcome.task.output, 'done');
  assert.equal(outcome.task.error, null);
  assert.deepEqual(outcome.task.rounds[0].result, {
    text: 'done',
    finishReason: 'completed',
    error: null,
  });
  assert.equal(source.status, 'running', 'the source record must stay untouched');
});

test('RuntimeOutcomeSettlement maps a provider error to one failed round', () => {
  const outcome = settlement().terminal({
    task: task(),
    message: {kind: 'error', roundId: 'round-1', error: 'boom', finishReason: 'error'},
  });
  assert.equal(outcome.task.status, 'failed');
  assert.equal(outcome.task.error, 'boom');
  assert.equal(outcome.event.kind, 'round_finished');
  assert.equal(outcome.event.status, 'failed');
});

test('RuntimeOutcomeSettlement returns a deferred fallback only for the first failed round', () => {
  const service = settlement({
    fallbackProvider: name => ({name, type: 'dsh-sdk', model: 'fallback'}),
    supportsEffort: () => true,
  });
  const outcome = service.firstRoundFailure(task(), {
    kind: 'error',
    roundId: 'round-1',
    error: 'primary failed',
    finishReason: 'error',
  }, 'fallback');
  assert.equal(outcome.task.status, 'failed');
  assert.equal(outcome.task.provider.name, 'fallback');
  assert.equal(outcome.fallback.providerName, 'fallback');
  assert.equal(outcome.event.kind, 'provider_fallback');
  assert.equal(service.firstRoundFailure({...task(), rounds: [{}, {}]}, {
    kind: 'error', roundId: 'r', finishReason: 'error',
  }, 'fallback'), null);
});

test('RuntimeOutcomeSettlement reports fallback lookup errors and never mutates its input', () => {
  const service = settlement({
    fallbackProvider: () => { throw new Error('unknown fallback'); },
  });
  const source = task();
  assert.throws(() => service.firstRoundFailure(source, {
    kind: 'error',
    roundId: 'round-1',
    error: 'primary failed',
    finishReason: 'error',
  }, 'fallback'), /unknown fallback/);
  assert.equal(source.status, 'running');
  assert.equal(source.rounds[0].result, undefined);
});

test('RuntimeOutcomeSettlement emits explicit protocol failures', () => {
  const service = settlement();
  const missing = service.missingTerminal({
    task: task(),
    message: {roundId: 'round-1'},
  });
  assert.equal(missing.task.status, 'failed');
  assert.equal(missing.event.kind, 'round_protocol_error');
  const busy = service.workerBusy({
    task: task(),
    message: {roundId: 'round-1'},
  });
  assert.equal(busy.event.kind, 'worker_busy');
  assert.deepEqual(busy.health, {health: 'unhealthy', detail: 'worker_busy'});
  const ack = service.ackTimeout({task: task(), roundId: 'round-1', timeoutMs: 2000});
  assert.equal(ack.event.kind, 'round_ack_timeout');
  assert.equal(ack.health.detail, 'ack timeout');
});
