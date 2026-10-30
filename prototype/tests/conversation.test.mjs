// Durable conversation store and the context-window rule used by adapters that
// keep continuity in a file (`sessionContinuity: 'file'`).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  CONVERSATION_FILE_NAME,
  completePairs,
  conversationFileFor,
  estimateTokens,
  fitConversation,
  readConversation,
  resetConversation,
  saveConversation,
} from '../../src/providers/conversation.mjs';
import {parseRunMessage, runMessage} from '../../src/runtime/protocol.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const base = path.join(HERE, '.tmp', `conversation-${process.pid}`);
fs.rmSync(base, {recursive: true, force: true});
fs.mkdirSync(base, {recursive: true});
let counter = 0;
const freshFile = () => conversationFileFor(path.join(base, `task-${++counter}`));

const user = content => ({role: 'user', content});
const assistant = content => ({role: 'assistant', content});
const call = (id, name = 'read_file') => ({
  role: 'assistant',
  content: null,
  tool_calls: [{id, type: 'function', function: {name, arguments: '{"path":"x"}'}}],
});
const result = (id, content = 'tool output') => ({role: 'tool', tool_call_id: id, content});
const round = (n, messages, extra = {}) => ({
  version: 1,
  roundId: `round-${n}`,
  provider: 'magpie',
  model: 'm',
  finishReason: 'completed',
  messages,
  ...extra,
});

/** Every tool call in `messages` has its result, and every result its call. */
function assertPaired(messages) {
  const open = new Set();
  for (const message of messages) {
    if (message.role === 'assistant') {
      assert.equal(open.size, 0, 'a new assistant turn must not leave tool calls unanswered');
      for (const tc of message.tool_calls ?? []) open.add(tc.id);
    } else if (message.role === 'tool') {
      assert.ok(open.delete(message.tool_call_id), `orphan tool result ${message.tool_call_id}`);
    } else {
      assert.equal(open.size, 0, 'a user or system message must not split a tool pair');
    }
  }
  assert.equal(open.size, 0, 'trailing tool calls without results');
}

test('the conversation file lives in the task run directory', () => {
  const dir = path.join(base, 'task-x');
  assert.equal(conversationFileFor(dir), path.join(dir, CONVERSATION_FILE_NAME));
  assert.equal(CONVERSATION_FILE_NAME, 'conversation.jsonl');
});

test('save and read round-trip one JSON line per round', () => {
  const file = freshFile();
  assert.deepEqual(readConversation(file), {rounds: [], error: null}, 'a missing file is an empty conversation');
  const rounds = [
    round(1, [user('first'), call('c1'), result('c1'), assistant('done one')]),
    round(2, [user('second'), assistant('done two')]),
  ];
  saveConversation(file, rounds);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), rounds[0]);
  assert.deepEqual(readConversation(file), {rounds, error: null});
  resetConversation(file);
  assert.equal(fs.existsSync(file), false);
  assert.doesNotThrow(() => resetConversation(file), 'resetting a missing file is a no-op');
});

test('an unreadable or malformed file is reported and treated as empty', () => {
  const file = freshFile();
  fs.mkdirSync(path.dirname(file), {recursive: true});
  for (const text of [
    'not json\n',
    `${JSON.stringify({version: 2, messages: []})}\n`,
    `${JSON.stringify(round(1, [user('x'), call('c1')]))}\n`,
    `${JSON.stringify(round(1, [assistant('no prompt first')]))}\n`,
  ]) {
    fs.writeFileSync(file, text);
    const read = readConversation(file);
    assert.deepEqual(read.rounds, []);
    assert.match(read.error, /conversation/i);
  }
});

test('completePairs drops a trailing tool call whose results never arrived', () => {
  const messages = [
    user('go'),
    call('c1'), result('c1'),
    {role: 'assistant', content: null, tool_calls: [
      {id: 'c2', type: 'function', function: {name: 'a', arguments: '{}'}},
      {id: 'c3', type: 'function', function: {name: 'b', arguments: '{}'}},
    ]},
    result('c2'),
  ];
  const kept = completePairs(messages);
  assert.deepEqual(kept, [user('go'), call('c1'), result('c1')]);
  assertPaired(kept);
  assert.deepEqual(completePairs([user('go'), assistant('done')]), [user('go'), assistant('done')]);
});

test('without a context window every stored round is sent', () => {
  const history = [round(1, [user('a'), assistant('b')]), round(2, [user('c'), assistant('d')])];
  const current = [user('e')];
  const fitted = fitConversation({history, current, maxTokens: 10});
  assert.deepEqual(fitted.messages, [user('a'), assistant('b'), user('c'), assistant('d'), user('e')]);
  assert.deepEqual(fitted.omitted, {rounds: 0, exchanges: 0});
});

test('the oldest whole rounds are dropped first and a note says so', () => {
  const big = 'x'.repeat(3000);
  const history = [
    round(1, [user(big), call('c1'), result('c1', big), assistant('one')]),
    round(2, [user('two'), call('c2'), result('c2'), assistant('two done')]),
  ];
  const current = [user('three')];
  const fitted = fitConversation({history, current, contextWindow: 1200, maxTokens: 200});
  assert.deepEqual(fitted.omitted, {rounds: 1, exchanges: 0});
  assert.equal(fitted.messages[0].role, 'system');
  assert.match(fitted.messages[0].content, /1 earlier round/);
  assert.deepEqual(fitted.messages.slice(1), [...history[1].messages, user('three')]);
  assertPaired(fitted.messages);
  assert.ok(estimateTokens(fitted.messages) + 200 <= 1200);
});

test('within the current round old tool exchanges go, the prompt and latest exchange stay', () => {
  const big = 'y'.repeat(2400);
  const current = [
    user('task'),
    call('c1'), result('c1', big),
    call('c2'), result('c2', big),
    call('c3'), result('c3', 'latest'),
  ];
  const fitted = fitConversation({history: [round(1, [user('old'), assistant('old done')])],
    current, contextWindow: 1400, maxTokens: 100});
  assert.deepEqual(fitted.omitted, {rounds: 1, exchanges: 1});
  assert.deepEqual(fitted.messages.slice(1), [user('task'), call('c2'), result('c2', big), call('c3'), result('c3', 'latest')]);
  assertPaired(fitted.messages);
});

test('a request that cannot fit fails with context_overflow instead of being sent', () => {
  const huge = 'z'.repeat(9000);
  assert.throws(
    () => fitConversation({history: [], current: [user(huge)], contextWindow: 1000, maxTokens: 100}),
    error => error.finishReason === 'context_overflow' && /context window/.test(error.message),
  );
  assert.throws(
    () => fitConversation({history: [], current: [user('x'), call('c1'), result('c1', huge)], contextWindow: 1000, maxTokens: 100}),
    error => error.finishReason === 'context_overflow',
  );
  assert.throws(
    () => fitConversation({history: [], current: [user('x')], contextWindow: 1000, maxTokens: 1000}),
    error => error.finishReason === 'context_overflow',
  );
});

test('the tool schema counts against the window', () => {
  const tools = [{type: 'function', function: {name: 't', description: 'd'.repeat(3400), parameters: {}}}];
  const history = [round(1, [user('a'), assistant('b')])];
  const without = fitConversation({history, current: [user('c')], contextWindow: 1200, maxTokens: 100});
  assert.equal(without.omitted.rounds, 0);
  assert.throws(
    () => fitConversation({history, current: [user('c')], contextWindow: 1200, maxTokens: 100, tools}),
    error => error.finishReason === 'context_overflow',
  );
});

test('the run message carries an optional conversation file', () => {
  const base = {
    roundId: 'round-01234567-89ab-cdef-0123-456789abcdef',
    task: {id: 'task-0123456789ab'},
    prompt: 'work',
    maxTokens: 1024,
    ownerMarker: 'owner',
  };
  assert.equal('conversationFile' in runMessage(base), false);
  const file = path.join(base.task.id, CONVERSATION_FILE_NAME);
  const message = runMessage({...base, conversationFile: file});
  assert.equal(message.conversationFile, file);
  assert.equal(parseRunMessage(message).ok, true);
  for (const conversationFile of ['', 3, {}, ['x']]) {
    const parsed = parseRunMessage({...message, conversationFile});
    assert.equal(parsed.ok, false);
    assert.match(parsed.reason, /conversationFile/);
  }
});
