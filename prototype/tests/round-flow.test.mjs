// One fake Worker drives a complete round through the real manager. The event
// journal must number every record once, in order, and a failed round must not
// repeat a Provider message id.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
// Isolation must load before manager/common so the data root is fixed.
import {REAL_ROOT,TEST_ROOT} from './isolate.mjs';
import {createManager} from '../manager.mjs';
import {ROOT} from '../common.mjs';
import {createFakeWorker} from './fake-worker.mjs';

const samePath = (a, b) => {
  const left = path.resolve(a), right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
};
if (samePath(ROOT, REAL_ROOT)) throw new Error(`round-flow tests refused live root ${ROOT}`);
if (!samePath(ROOT, TEST_ROOT)) throw new Error(`round-flow tests refused non-isolated root ${ROOT}`);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const base = path.join(HERE, '.tmp', `round-flow-${process.pid}`);
fs.rmSync(base, {recursive: true, force: true});
fs.mkdirSync(base, {recursive: true});

const escape = id => `"${id}"`;

function workerFor(events, {fail = false} = {}) {
  return createFakeWorker({
    pid: 4800,
    onRun: ({message, reply}) => {
      const roundId = message.roundId;
      reply.ready({roundId, ownerMarker: message.ownerMarker});
      reply.ack(roundId);
      for (const event of events) reply.event(roundId, event);
      setImmediate(() => {
        if (fail) reply.error(roundId, {error: 'provider failed'});
        else reply.result(roundId, {text: 'done'});
        reply.release(roundId);
      });
    },
  });
}

const messageEvent = id => ({
  type: 'assistant/message',
  data: {message: {id, role: 'assistant', content: [{type: 'text', text: 'synthetic'}]}},
});

let counter = 0;
const newWorkspace = () => {
  const dir = path.join(base, `ws-${++counter}`);
  fs.mkdirSync(dir, {recursive: true});
  return dir;
};

async function settled(manager, id) {
  for (let i = 0; i < 300; i += 1) {
    const status = await manager.action('status', {id});
    if (status.status !== 'running' && status.status !== 'stopping') return status;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('task did not settle');
}

function journal(status) {
  return fs.readFileSync(path.join(status.dataDirectory, 'events.jsonl'), 'utf8')
    .trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function assertJournalOnce(status, ids) {
  const text = fs.readFileSync(path.join(status.dataDirectory, 'events.jsonl'), 'utf8');
  const events = journal(status);
  const sequences = events.map(event => event.sequence);
  assert.deepEqual(sequences, sequences.map((_, index) => index + 1), 'sequences are continuous');
  assert.equal(new Set(sequences).size, sequences.length, 'sequences are unique');
  for (const id of ids) {
    assert.equal(text.split(escape(id)).length - 1, 1, `${id} appears once`);
  }
}

test('a full run -> ack -> events -> result -> released flow journals each event once', async () => {
  const ids = ['message-one', 'message-two'];
  const manager = createManager({forkWorker: () => workerFor(ids.map(messageEvent))});
  try {
    const created = await manager.action('create', {
      workspace: newWorkspace(),
      prompt: 'work',
      plan: 'p',
      criteria: 'c',
      provider: 'deepseek-flash',
    });
    const status = await settled(manager, created.id);
    assert.equal(status.status, 'awaiting_review');
    assertJournalOnce(status, ids);
  } finally {
    await manager.shutdown();
  }
});

test('a failed round journals each Provider message id once', async () => {
  const ids = ['message-failed'];
  const manager = createManager({forkWorker: () => workerFor(ids.map(messageEvent), {fail: true})});
  try {
    const created = await manager.action('create', {
      workspace: newWorkspace(),
      prompt: 'work',
      plan: 'p',
      criteria: 'c',
      provider: 'deepseek-flash',
    });
    const status = await settled(manager, created.id);
    assert.equal(status.status, 'failed');
    assertJournalOnce(status, ids);
  } finally {
    await manager.shutdown();
  }
});
