// openai-chat rework continuity: a later round sends the earlier rounds'
// messages, the file outlives the adapter and the Worker process, trimming keeps
// tool pairs, and a missing conversation file keeps the single-round behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {OpenAIChatAdapter} from '../providers/openai-chat.mjs';
import {conversationFileFor, readConversation} from '../../src/providers/conversation.mjs';
import {capabilitiesFor, validateProviderConfig} from '../providers/registry.mjs';
import {createRoundId, runMessage} from '../../src/runtime/protocol.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const base = path.join(HERE, '.tmp', `openai-chat-conversation-${process.pid}`);
fs.rmSync(base, {recursive: true, force: true});
fs.mkdirSync(base, {recursive: true});
let counter = 0;
const freshFile = () => conversationFileFor(path.join(base, `task-${++counter}`));

const tools = [{
  name: 'read_file',
  description: 'Read a file',
  input_schema: {type: 'object', properties: {path: {type: 'string'}}, required: ['path']},
}];

const toolCall = id => ({content: null, tool_calls: [{
  id, type: 'function', function: {name: 'read_file', arguments: '{"path":"notes.txt"}'},
}]});
const answer = content => ({content});

/**
 * A scripted transport: each request records a deep copy of the messages it
 * was sent and answers with the next scripted message.
 */
function scripted(replies) {
  const requests = [];
  const transport = async (url, body) => {
    requests.push(structuredClone(body.messages));
    const message = replies.shift();
    if (!message) throw new Error('script exhausted');
    if (message instanceof Error) throw message;
    return {status: 200, raw: null, json: {
      id: `msg-${requests.length}`,
      model: 'test-model',
      choices: [{message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop'}],
      usage: {prompt_tokens: 10, completion_tokens: 2, total_tokens: 12},
    }};
  };
  return {transport, requests};
}

function adapter(transport, extra = {}) {
  return new OpenAIChatAdapter({name: 'magpie', type: 'openai-chat', baseUrl: 'http://unused.invalid',
    apiKey: 'test-key', model: 'test-model', ...extra}, {transport});
}

const run = (instance, prompt, conversationFile, extra = {}) => instance.run({
  prompt, tools, maxTokens: 64, conversationFile, roundId: createRoundId(),
  onToolCall: () => ({content: 'notes say: use tabs'}), ...extra,
});

test('openai-chat declares file-backed continuity', () => {
  assert.equal(capabilitiesFor({name: 'chat', type: 'openai-chat'}).sessionContinuity, 'file');
});

test('a rework round sends the previous round, tool pair included, to the transport', async () => {
  const file = freshFile();
  const {transport, requests} = scripted([toolCall('call-1'), answer('round one done'), answer('fixed')]);
  const first = await run(adapter(transport), 'implement the parser', file);
  assert.equal(first.text, 'round one done');

  const second = await run(adapter(transport), 'rework: handle empty input', file);
  assert.equal(second.text, 'fixed');
  assert.deepEqual(requests[2], [
    {role: 'user', content: 'implement the parser'},
    {role: 'assistant', content: null, tool_calls: toolCall('call-1').tool_calls},
    {role: 'tool', tool_call_id: 'call-1', content: 'notes say: use tabs'},
    {role: 'assistant', content: 'round one done'},
    {role: 'user', content: 'rework: handle empty input'},
  ]);

  const {rounds, error} = readConversation(file);
  assert.equal(error, null);
  assert.equal(rounds.length, 2);
  assert.equal(rounds[0].provider, 'magpie');
  assert.equal(rounds[0].model, 'test-model');
  assert.equal(rounds[0].finishReason, 'completed');
  assert.deepEqual(rounds[1].messages.at(-1), {role: 'assistant', content: 'fixed'});
});

test('without a conversation file nothing is stored and each round starts empty', async () => {
  const {transport, requests} = scripted([answer('a'), answer('b')]);
  const instance = adapter(transport);
  await run(instance, 'one', undefined);
  await run(instance, 'two', undefined);
  assert.deepEqual(requests[1], [{role: 'user', content: 'two'}]);
});

test('a failed round keeps its prompt and complete tool pairs for the rework', async () => {
  const file = freshFile();
  const {transport, requests} = scripted([toolCall('call-1'), new Error('upstream 502'), answer('recovered')]);
  await assert.rejects(run(adapter(transport), 'first try', file), /upstream 502/);
  const stored = readConversation(file).rounds;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].finishReason, 'error');
  assert.deepEqual(stored[0].messages.map(m => m.role), ['user', 'assistant', 'tool']);

  await run(adapter(transport), 'try again', file);
  assert.deepEqual(requests[2].map(m => m.role), ['user', 'assistant', 'tool', 'user']);
});

test('trimming to the provider window drops whole old rounds and keeps tool pairs', async () => {
  const file = freshFile();
  const big = 'x'.repeat(4500);
  const {transport, requests} = scripted([toolCall('call-1'), answer(big), answer('second done'), answer('third done')]);
  const events = [];
  const window = {contextWindow: 1600};
  await run(adapter(transport, window), 'round one', file);
  await run(adapter(transport, window), 'round two', file);
  await run(adapter(transport, window), 'round three', file, {onEvent: event => events.push(event)});

  const sent = requests[3];
  assert.equal(sent[0].role, 'system');
  assert.match(sent[0].content, /1 earlier round/);
  assert.deepEqual(sent.slice(1).map(m => m.content), ['round two', 'second done', 'round three']);
  assert.ok(events.some(event => event.type === 'provider/conversation-trimmed' &&
    event.data.omittedRounds === 1));
  // The stored file keeps every round; only the request is bounded.
  assert.equal(readConversation(file).rounds.length, 3);
});

test('a prompt that cannot fit the window fails before any request', async () => {
  const file = freshFile();
  const {transport, requests} = scripted([answer('never')]);
  await assert.rejects(
    run(adapter(transport, {contextWindow: 500}), 'p'.repeat(4000), file),
    error => error.finishReason === 'context_overflow',
  );
  assert.equal(requests.length, 0);
});

test('a rework on another openai-chat provider continues the same conversation', async () => {
  // Rework has no provider field; the provider changes between rounds only
  // after a first-round fallback. The manager resets the file for the fallback
  // round, so whatever conversation exists belongs to the task's current work
  // and is continued by any file-backed provider, fitted to its own window.
  const file = freshFile();
  const {transport, requests} = scripted([answer('from magpie'), answer('from kimi')]);
  await run(adapter(transport), 'first', file);
  await run(adapter(transport, {name: 'rl2-kimi', model: 'llm-default'}), 'second', file);
  assert.deepEqual(requests[1].map(m => m.content), ['first', 'from magpie', 'second']);
  assert.deepEqual(readConversation(file).rounds.map(r => r.provider), ['magpie', 'rl2-kimi']);
});

test('the conversation survives a new Worker process', async t => {
  const file = freshFile();
  const seen = [];
  const replies = ['round one done', 'round two done'];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      seen.push(JSON.parse(Buffer.concat(chunks).toString('utf8')).messages);
      res.writeHead(200, {'content-type': 'application/json', connection: 'close'});
      res.end(JSON.stringify({id: `m-${seen.length}`, model: 'test-model',
        choices: [{message: {content: replies.shift()}, finish_reason: 'stop'}],
        usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2}}));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const provider = {name: 'magpie', type: 'openai-chat', baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    apiKey: 'test-key', model: 'test-model', stream: false};
  const task = {id: 'task-0123456789ab', provider, workspace: base};
  try {
    for (const prompt of ['first round', 'rework round']) {
      let worker;
      try {
        worker = fork(path.join(HERE, '..', 'worker.mjs'), [], {stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
      } catch (error) {
        if (error.code === 'EPERM') { t.skip('process spawning is unavailable here'); return; }
        throw error;
      }
      const spawned = await new Promise(resolve => {
        worker.once('error', error => resolve(error));
        worker.once('spawn', () => resolve(null));
      });
      if (spawned?.code === 'EPERM') { t.skip('process spawning is unavailable here'); return; }
      if (spawned) throw spawned;
      const terminal = await new Promise((resolve, reject) => {
        const roundId = createRoundId();
        let outcome = null;
        worker.on('message', message => {
          if (message.kind === 'result' || message.kind === 'error') outcome = message;
          if (message.kind === 'released') resolve(outcome);
        });
        worker.once('exit', code => reject(new Error(`worker exited early (${code})`)));
        worker.send(runMessage({roundId, task, prompt, maxTokens: 64, ownerMarker: 'owner',
          conversationFile: file}));
      });
      assert.equal(terminal.kind, 'result', terminal.error);
      worker.removeAllListeners('exit');
      const exited = new Promise(resolve => worker.once('exit', resolve));
      worker.send({kind: 'close'});
      await exited;
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  assert.deepEqual(seen[1].map(m => m.content), ['first round', 'round one done', 'rework round']);
});

test('provider config validates the optional context window', () => {
  const base = {name: 'test', type: 'openai-chat', model: 'test-model'};
  for (const contextWindow of [undefined, null, 1, 64000]) {
    assert.doesNotThrow(() => validateProviderConfig({...base, contextWindow}));
  }
  for (const contextWindow of [0, -1, 1.5, '64000', NaN, Infinity]) {
    assert.throws(() => validateProviderConfig({...base, contextWindow}), /contextWindow must be a positive safe integer/);
  }
});
