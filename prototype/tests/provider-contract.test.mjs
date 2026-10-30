// Provider seam contract. Both adapters answer the same run -> events ->
// result shape, capabilities replace provider-type branches, the DSH adapter
// owns its task patch, and openai-chat's tool loop runs on an injected
// transport instead of a loopback server.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DshSdkAdapter} from '../providers/dsh-sdk.mjs';
import {OpenAIChatAdapter} from '../providers/openai-chat.mjs';
import {
  capabilitiesFor,
  prepareTask,
  resolveProvider,
  validateProviderConfig,
} from '../providers/registry.mjs';
import {eventMessage, validateMessage} from '../../src/runtime/protocol.mjs';

const ROUND = 'round-01234567-89ab-cdef-0123-456789abcdef';
const HERE = path.dirname(fileURLToPath(import.meta.url));

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'waxwing-provider-'));
}

function taskFor(dir, extra = {}) {
  return {
    sessionId: 'session-1',
    workspace: dir,
    home: dir,
    patch: path.join(dir, 'runtime.patch.json'),
    model: 'test-model',
    ...extra,
  };
}

function assertProtocolEvents(events) {
  assert.ok(events.length > 0, 'the adapter emits at least one event');
  for (const event of events) {
    assert.equal(typeof event.type, 'string');
    const checked = validateMessage({...eventMessage(event), roundId: ROUND});
    assert.equal(checked.ok, true, `${event.type}: ${checked.reason}`);
  }
}

/** A harness lookalike: one session per adapter, scripted notifications. */
function fakeHarness({reason = 'completed', notifications = []} = {}) {
  const calls = {starts: 0, runs: [], closes: 0};
  return {
    calls,
    async start() {
      calls.starts += 1;
    },
    async run(prompt, options) {
      calls.runs.push({prompt, sessionId: options.sessionId});
      for (const notification of notifications) options.onNotification?.(notification);
      return {
        finalResponse: 'done',
        events: [{type: 'turn/end', data: {reason: {kind: reason}}}],
      };
    },
    async close() {
      calls.closes += 1;
    },
  };
}

function reply(message, finishReason = 'stop', usage = {prompt_tokens: 10, completion_tokens: 2, total_tokens: 12}) {
  return {
    status: 200,
    raw: null,
    json: {
      id: 'resp-1',
      model: 'test-model',
      created: 1,
      choices: [{message, finish_reason: finishReason}],
      usage,
    },
  };
}

function scriptedTransport(responses) {
  const calls = [];
  return {
    calls,
    async transport(url, body, apiKey) {
      calls.push({url, body, apiKey});
      const next = responses[calls.length - 1];
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

test('both adapters produce the same result shape and protocol-valid events', async () => {
  const dshDir = tempDir();
  const harness = fakeHarness({notifications: [{method: 'session.event', params: {event: {type: 'assistant/message'}}}]});
  const dsh = new DshSdkAdapter({name: 'dsh-sdk', type: 'dsh-sdk'}, {createHarness: async () => harness});
  const dshEvents = [];
  const dshResult = await dsh.run({
    prompt: 'work',
    maxTokens: 128,
    task: taskFor(dshDir),
    budgetFile: path.join(dshDir, 'budget.json'),
    onEvent: event => dshEvents.push(event),
  });
  assert.equal(dshResult.text, 'done');
  assert.equal(dshResult.finishReason, 'completed');
  assertProtocolEvents(dshEvents);

  const {transport} = scriptedTransport([reply({content: 'done'})]);
  const openai = new OpenAIChatAdapter(
    {name: 'test', type: 'openai-chat', baseUrl: 'https://example.invalid/v1', apiKey: 'key', model: 'test-model'},
    {transport},
  );
  const openaiEvents = [];
  const openaiResult = await openai.run({
    prompt: 'work',
    history: [],
    tools: [],
    maxTokens: 128,
    onEvent: event => openaiEvents.push(event),
  });
  assert.equal(openaiResult.text, 'done');
  assert.equal(openaiResult.finishReason, 'completed');
  assertProtocolEvents(openaiEvents);
});

test('capabilities replace provider-type branches', () => {
  assert.deepEqual(capabilitiesFor({name: 'dsh', type: 'dsh-sdk'}), {
    effort: false,
    sessionContinuity: 'process',
    budgetPatch: true,
  });
  assert.equal(capabilitiesFor({name: 'chat', type: 'openai-chat', supportsReasoning: true}).effort, true);
  assert.equal(capabilitiesFor({name: 'chat', type: 'openai-chat'}).effort, false);
  assert.equal(capabilitiesFor({name: 'chat', type: 'openai-chat'}).budgetPatch, false);

  const source = fs.readFileSync(path.join(HERE, '..', 'manager.mjs'), 'utf8');
  assert.equal(/['"]dsh(?:-sdk)?['"]/i.test(source), false, 'the manager never names the DSH type');
  assert.equal(/provider\.type\s*===/.test(source), false, 'the manager never branches on a type');
  const worker = fs.readFileSync(path.join(HERE, '..', 'worker.mjs'), 'utf8');
  assert.equal(/providerType/.test(worker), false, 'the worker never branches on a provider type');
});

test('the DSH adapter keeps one harness across rounds and announces one start', async () => {
  const dir = tempDir();
  const harness = fakeHarness();
  let built = 0;
  const adapter = new DshSdkAdapter({name: 'dsh-sdk', type: 'dsh-sdk'}, {
    createHarness: async () => {
      built += 1;
      return harness;
    },
  });
  let starts = 0;
  const run = () => adapter.run({
    prompt: 'work',
    maxTokens: 64,
    task: taskFor(dir),
    budgetFile: path.join(dir, 'budget.json'),
    onStart: () => { starts += 1; },
  });

  await run();
  await run();
  assert.equal(built, 1, 'the harness is built once');
  assert.equal(starts, 1, 'only the first round starts a session');
  assert.deepEqual(harness.calls.runs.map(entry => entry.sessionId), ['session-1', 'session-1']);
  assert.equal(fs.readFileSync(path.join(dir, 'budget.json'), 'utf8').length > 0, true);

  await adapter.close();
  assert.equal(harness.calls.closes, 1);
});

test('openai-chat runs its tool loop on the injected transport', async () => {
  const scripted = scriptedTransport([
    reply({
      content: null,
      tool_calls: [{id: 'call-1', type: 'function', function: {name: 'read_file', arguments: '{"path":"x"}'}}],
    }, 'tool_calls'),
    reply({content: 'finished'}),
  ]);
  const calls = [];
  const adapter = new OpenAIChatAdapter(
    {name: 'test', type: 'openai-chat', baseUrl: 'https://example.invalid/v1', apiKey: 'key', model: 'test-model'},
    {transport: scripted.transport},
  );
  const result = await adapter.run({
    prompt: 'work',
    history: [],
    tools: [{name: 'read_file', input_schema: {type: 'object', properties: {}}}],
    maxTokens: 16,
    onToolCall: async (name, args) => {
      calls.push({name, args});
      return {content: 'tool result'};
    },
  });

  assert.equal(result.text, 'finished');
  assert.deepEqual(calls, [{name: 'read_file', args: {path: 'x'}}]);
  assert.equal(scripted.calls.length, 2);
  const second = scripted.calls[1].body.messages;
  assert.ok(second.some(message => message.role === 'tool' && message.content === 'tool result'));
});

test('openai-chat reports upstream errors and interrupted streams through events', async () => {
  const failed = new OpenAIChatAdapter(
    {name: 'test', type: 'openai-chat', baseUrl: 'https://example.invalid/v1', apiKey: 'key', model: 'test-model'},
    {transport: scriptedTransport([{status: 500, raw: 'boom', json: null}]).transport},
  );
  const failedEvents = [];
  await assert.rejects(
    failed.run({prompt: 'work', history: [], tools: [], maxTokens: 16, onEvent: event => failedEvents.push(event)}),
    /OpenAI API error 500: boom/,
  );
  assert.ok(failedEvents.some(event => event.type === 'provider/request-failed'));

  const interrupted = new OpenAIChatAdapter(
    {name: 'test', type: 'openai-chat', baseUrl: 'https://example.invalid/v1', apiKey: 'key', model: 'test-model'},
    {transport: scriptedTransport([new Error('Invalid streaming response: socket closed')]).transport},
  );
  const interruptedEvents = [];
  await assert.rejects(
    interrupted.run({prompt: 'work', history: [], tools: [], maxTokens: 16,
      onEvent: event => interruptedEvents.push(event)}),
    /socket closed/,
  );
  assert.ok(interruptedEvents.some(event => event.type === 'provider/request-failed'));
});

test('the registry resolves built-in providers before provider files', () => {
  assert.deepEqual(resolveProvider('unused-dir', 'dsh', {model: 'm'}), {name: 'dsh-sdk', type: 'dsh-sdk', model: 'm'});
  assert.deepEqual(resolveProvider('unused-dir', 'dsh-sdk', {model: 'm'}), {name: 'dsh-sdk', type: 'dsh-sdk', model: 'm'});
  assert.throws(() => resolveProvider('unused-dir', 'missing'), /not found/);
  assert.throws(() => validateProviderConfig({name: 'x', type: 'unknown'}), /unknown type/);
});

test('prepareTask writes the DSH runtime patch and nothing for openai-chat', () => {
  const dir = tempDir();
  const task = {patch: path.join(dir, 'runtime.patch.json')};
  prepareTask({name: 'dsh-sdk', type: 'dsh-sdk'}, task, {
    directory: dir,
    credentialsFile: path.join(dir, 'credentials.json'),
  });
  const patch = JSON.parse(fs.readFileSync(task.patch, 'utf8'));
  const inserted = patch.flatMap(row => row.insert ?? []).find(entry => entry.id === 'task-budget');
  assert.ok(inserted, 'the budget plugin must be inserted, not overridden');
  assert.match(inserted.name, /budget-plugin\.mjs$/);

  const other = {patch: path.join(dir, 'other.patch.json')};
  assert.equal(prepareTask({name: 'chat', type: 'openai-chat'}, other, {
    directory: dir,
    credentialsFile: path.join(dir, 'credentials.json'),
  }), null);
  assert.equal(fs.existsSync(other.patch), false);
});
