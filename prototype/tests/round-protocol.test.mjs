// The round protocol is one definition for both processes: message shapes,
// version checks, event normalization, and the shared fake Worker.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROUND_PROTOCOL_VERSION,
  ackMessage,
  closeMessage,
  eventMessage,
  parseRunMessage,
  readyMessage,
  resultMessage,
  runMessage,
  validateMessage,
} from '../../src/runtime/protocol.mjs';

const ROUND = 'round-01234567-89ab-cdef-0123-456789abcdef';

function run(extra = {}) {
  return runMessage({
    roundId: ROUND,
    task: {id: 'task-0123456789ab'},
    prompt: 'work',
    maxTokens: 1024,
    ownerMarker: 'owner',
    ...extra,
  });
}

test('run messages carry the protocol version and parse back only when valid', () => {
  const message = run();
  assert.equal(message.protocolVersion, ROUND_PROTOCOL_VERSION);
  assert.deepEqual(parseRunMessage(message), {ok: true, reason: null, message});

  assert.equal(parseRunMessage({...message, protocolVersion: ROUND_PROTOCOL_VERSION + 1}).ok, false);
  assert.match(parseRunMessage({...message, protocolVersion: ROUND_PROTOCOL_VERSION + 1}).reason, /protocol version/);
  assert.equal(parseRunMessage({...message, roundId: 'round-nope'}).ok, false);
  assert.equal(parseRunMessage({...message, prompt: 3}).ok, false);
  assert.equal(parseRunMessage({kind: 'ack'}).ok, false);
  assert.throws(() => runMessage({roundId: 'round-nope', task: {}, prompt: 'x'}), /valid roundId/);
});

test('every message kind has a valid sample and malformed samples are rejected', () => {
  const samples = [
    readyMessage({pid: 1, startedAt: 'now', ownerMarker: 'owner'}),
    closeMessage(),
    {...ackMessage(), roundId: ROUND},
    {...eventMessage({type: 'assistant/message', data: {}}), roundId: ROUND},
    {...resultMessage({text: 'done', finishReason: 'completed'}), roundId: ROUND},
    {...resultMessage({text: 'done', finishReason: 'completed'}), roundId: ROUND, kind: 'error', error: 'boom'},
    {...resultMessage({text: 'done', finishReason: 'completed'}), roundId: ROUND, kind: 'worker_busy'},
    {...resultMessage({text: 'done', finishReason: 'completed'}), roundId: ROUND, kind: 'released'},
    {...resultMessage({text: 'done', finishReason: 'completed'}), roundId: ROUND, kind: 'close_error', error: 'x'},
    {...resultMessage({text: 'done', finishReason: 'completed'}), roundId: ROUND, kind: 'protocol_error', error: 'x'},
    {...resultMessage({text: 'done', finishReason: 'completed'}), roundId: ROUND, kind: 'closed'},
  ];
  for (const sample of samples) {
    const checked = validateMessage(sample);
    assert.equal(checked.ok, true, `${sample.kind}: ${checked.reason}`);
  }
  const invalid = [
    null,
    {},
    {kind: 'nope'},
    {...ackMessage(), roundId: 'bad'},
    {...ackMessage(), protocolVersion: 99},
    {kind: 'event', roundId: ROUND},
    {kind: 'error', roundId: ROUND},
    {kind: 'close_error'},
    {kind: 'protocol_error'},
  ];
  for (const sample of invalid) {
    assert.equal(validateMessage(sample).ok, false, JSON.stringify(sample));
  }
});

test('event messages normalize both Provider wrappers to one nested event', () => {
  const bare = eventMessage({type: 'assistant/message', data: {x: 1}});
  assert.equal(bare.notification.method, 'session.event');
  assert.equal(bare.notification.params.event.type, 'assistant/message');

  const dsh = eventMessage({method: 'session.event', params: {event: {type: 'turn/end', data: {}}}});
  assert.equal(dsh.notification.params.event.type, 'turn/end');
  assert.equal(validateMessage({...dsh, roundId: ROUND}).ok, true);
});
